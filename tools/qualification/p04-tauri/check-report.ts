// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Verifier of the series reports of P04 (CA-43, CA-44, CA-48).
//
//   bun tools/qualification/p04-tauri/check-report.ts [--root DIR] [--report DIR]...
//
// Without --report, every `reports/*/manifest.json` is checked. For each report
// it reads the manifest and, for every threshold of PROTOCOL.md section 3:
// the entry exists once with the protocol's words, its raw output is present
// inside the report directory, and the value and verdict recomputed from that
// raw output equal the declared ones. It also checks the commit measured, the
// machine class, the corpus SHA-256, the SHA-256 of the binary measured, the
// launches rejected and the stop of the series (section 10.7), the frame
// periods and the gaps of section 10.1, and the freeze of PROTOCOL.md (section
// 10.8): the protocol it applies is PROTOCOL.md at the commit P, read by git and
// never in the working tree, and its SHA-256 must be the one the series read.
//
// Exit 0: every threshold examined and green. Exit 1: complete, at least one
// threshold red. Exit 2: incomplete (no report, a missing or contradicted raw
// output, a broken freeze...): nothing can be concluded. The number of
// thresholds examined is printed in every case.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  type NotebookResourceClassManifest,
  parseResourceClassManifest,
  selectResourceClass,
} from "../notebook-core-v2/resource-class";
import { evaluate, gapsOf } from "./series/evaluate";
import {
  defectOf,
  fromJsonValue,
  MANIFEST_SCHEMA,
  REJECTION_CAUSES,
  STOP_CAUSES,
  type StopCause,
} from "./series/manifest";
import {
  FRAME_PERIOD_INTERVALS,
  type MeasureSpec,
  measureSpecs,
  PROTOCOL_RELATIVE_PATH,
  seriesParameters,
} from "./series/protocol";
import { summary } from "./series/stats";

export const REPORTS_RELATIVE_PATH = "tools/qualification/p04-tauri/reports";

interface Outcome {
  examined: number;
  pass: number;
  fail: number;
  issues: string[];
}

function git(root: string, args: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode ?? -1, out: result.stdout.toString().trim() };
}

// PROTOCOL.md section 10.8: P, the last commit that changes PROTOCOL.md, must
// differ from and be an ancestor of R, the first commit that adds a report file.
export function freezeIssues(root: string): string[] {
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.code !== 0) return ["freeze: the root is not a git repository"];
  if (shallow.out === "true") return ["freeze: shallow history, the freeze cannot be checked"];
  const protocolCommit = git(root, ["log", "-1", "--format=%H", "--", PROTOCOL_RELATIVE_PATH]).out;
  if (protocolCommit === "") return ["freeze: no commit changes PROTOCOL.md"];
  const additions = git(root, [
    "log",
    "--diff-filter=A",
    "--format=%H",
    "--",
    REPORTS_RELATIVE_PATH,
  ]).out;
  const reportCommit = additions
    .split("\n")
    .filter((line) => line !== "")
    .at(-1);
  if (reportCommit === undefined)
    return ["freeze: no commit adds a report, the freeze cannot be checked"];
  if (protocolCommit === reportCommit) {
    return [
      `freeze: PROTOCOL.md and the first report are added by the same commit ${reportCommit}`,
    ];
  }
  if (git(root, ["merge-base", "--is-ancestor", protocolCommit, reportCommit]).code !== 0) {
    return [
      `freeze: PROTOCOL.md changed in ${protocolCommit}, after the first report ${reportCommit}`,
    ];
  }
  return [];
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// A raw path is relative, normalised, and stays inside the report directory.
function rawPath(reportDirectory: string, declared: unknown): string | null {
  if (typeof declared !== "string" || declared === "" || isAbsolute(declared)) return null;
  const target = resolve(reportDirectory, declared);
  const inside = relative(reportDirectory, target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return null;
  return target;
}

function checkMachine(
  machine: Record<string, unknown> | null,
  expectedClass: string,
  classes: NotebookResourceClassManifest,
): string[] {
  if (machine === null) return ["machine: missing"];
  const strings = [
    "class",
    "operatingSystem",
    "architecture",
    "hardwareModel",
    "processor",
    "osVersion",
  ];
  const missing = strings.filter((key) => typeof machine[key] !== "string" || machine[key] === "");
  if (typeof machine.memoryBytes !== "number") missing.push("memoryBytes");
  if (typeof machine.logicalCpu !== "number") missing.push("logicalCpu");
  if (typeof machine.hypervisorPresent !== "boolean") missing.push("hypervisorPresent");
  if (missing.length > 0) return [`machine: missing ${missing.join(", ")}`];
  if (machine.class !== expectedClass) {
    return [`machine: class ${String(machine.class)}, the protocol requires ${expectedClass}`];
  }
  if (machine.hypervisorPresent === true)
    return ["machine: a virtual machine is not a measurement machine"];
  try {
    selectResourceClass(classes, expectedClass, {
      architecture: String(machine.architecture),
      hardwareModel: String(machine.hardwareModel),
      hypervisorPresent: false,
      logicalCpu: Number(machine.logicalCpu),
      memoryBytes: Number(machine.memoryBytes),
      operatingSystem: String(machine.operatingSystem),
      processor: String(machine.processor),
    });
  } catch (error) {
    return [`machine: ${error instanceof Error ? error.message : String(error)}`];
  }
  return [];
}

// PROTOCOL.md section 10.7: one non-negative integer per cause of the closed set, nothing else.
function rejectedLaunchesIssues(value: unknown): string[] {
  const counts = object(value);
  if (counts === null) return ["rejectedLaunches is not an object"];
  const keys = Object.keys(counts);
  const unknown = keys.filter((key) => !(REJECTION_CAUSES as readonly string[]).includes(key));
  const missing = REJECTION_CAUSES.filter((cause) => !keys.includes(cause));
  const invalid = REJECTION_CAUSES.filter((cause) => {
    const count = counts[cause];
    return (
      cause in counts && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    );
  });
  const issues: string[] = [];
  if (unknown.length > 0)
    issues.push(`rejectedLaunches: causes outside the closed set: ${unknown.join(", ")}`);
  if (missing.length > 0) issues.push(`rejectedLaunches: missing causes: ${missing.join(", ")}`);
  if (invalid.length > 0)
    issues.push(`rejectedLaunches: not a non-negative integer: ${invalid.join(", ")}`);
  return issues;
}

// PROTOCOL.md section 10.7: null, or the stop of the series by three rejections or
// interruptions of one cause in a row, which leaves the report without a verdict.
function stoppedIssues(value: unknown): string[] {
  if (value === null) return [];
  const stop = object(value);
  if (stop === null) return ["stopped is not recorded (null, or the stop of the series)"];
  const cause = stop.cause;
  if (!(STOP_CAUSES as readonly unknown[]).includes(cause)) {
    return [`stopped: cause ${String(cause)} is outside the closed set`];
  }
  const known = cause as StopCause;
  if (stop.defect !== defectOf(known)) {
    return [`stopped: ${known} is a defect of the ${defectOf(known)}, not ${String(stop.defect)}`];
  }
  if (typeof stop.unit !== "string" || stop.unit === "") return ["stopped: no unit"];
  return [
    `the series stopped at ${stop.unit}: 3 consecutive ${known}, a defect of the ${defectOf(known)}; no verdict`,
  ];
}

// PROTOCOL.md section 10.7: after a corrected instrument or product the series
// starts again from zero, so every sample of a report was measured with the one
// binary and instrument of its manifest.
function measuredWithIssues(
  spec: MeasureSpec,
  raw: unknown,
  run: Record<string, unknown>,
): string[] {
  const declared = object(object(raw)?.measuredWith);
  const keys = ["binarySha256", "harnessCommit", "scriptSha256"];
  const same =
    declared !== null &&
    Object.keys(declared).length === keys.length &&
    keys.every((key) => typeof run[key] === "string" && declared[key] === run[key]);
  return same
    ? []
    : [
        `${spec.id}: measured with ${JSON.stringify(declared)}, not the binary and instrument of the manifest`,
      ];
}

// PROTOCOL.md section 10.1: one frame period of 600 intervals per launch of AT-02
// and NFR-03, none for the other measures, each with p50 <= p95 <= maximum.
function framePeriodIssues(spec: MeasureSpec, value: unknown): string[] {
  if (!Array.isArray(value)) return [`${spec.id}: framePeriods is not recorded`];
  if (value.length !== spec.framedLaunches) {
    return [`${spec.id}: ${value.length} frame periods for ${spec.framedLaunches} launches`];
  }
  const issues: string[] = [];
  value.forEach((entry, index) => {
    const period = object(entry);
    const statistic = (key: string): number | null => {
      const number = period?.[key];
      return typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : null;
    };
    const [p50, p95, max] = [statistic("p50Ms"), statistic("p95Ms"), statistic("maxMs")];
    if (
      period?.intervals !== FRAME_PERIOD_INTERVALS ||
      p50 === null ||
      p95 === null ||
      max === null ||
      p50 > p95 ||
      p95 > max
    ) {
      issues.push(
        `${spec.id}: frame period of launch ${index} is not ${FRAME_PERIOD_INTERVALS} intervals with p50 <= p95 <= maximum`,
      );
    }
  });
  return issues;
}

// PROTOCOL.md section 10.1: per configuration of AT-02, the gap from observation
// to end bound, summarised from the gaps of the raw output; null elsewhere.
function boundGapIssues(spec: MeasureSpec, declared: unknown, raw: unknown): string[] {
  if (!spec.id.startsWith("at-02")) {
    return declared === null ? [] : [`${spec.id}: boundGap is recorded for AT-02 only`];
  }
  const record = object(raw) ?? {};
  const samples = Array.isArray(record.samples) ? (record.samples as (number | null)[]) : [];
  const expected = summary(gapsOf(record, samples));
  if (JSON.stringify(declared) !== JSON.stringify(expected)) {
    return [
      `${spec.id}: boundGap ${JSON.stringify(declared)} differs from the gaps of the raw output ${JSON.stringify(expected)}`,
    ];
  }
  return [];
}

function checkReport(
  root: string,
  reportDirectory: string,
  specs: readonly MeasureSpec[],
  context: {
    corpusSha256: string;
    machineClass: string;
    classes: NotebookResourceClassManifest;
    protocolSha256: string;
    protocolCommit: string;
  },
  outcome: Outcome,
): void {
  const name = relative(root, reportDirectory) || reportDirectory;
  const issue = (message: string) => outcome.issues.push(`${name}: ${message}`);
  const manifestPath = join(reportDirectory, "manifest.json");
  let manifest: Record<string, unknown> | null;
  try {
    manifest = object(readJson(manifestPath));
  } catch (error) {
    issue(`manifest.json unreadable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (manifest === null) {
    issue("manifest.json is not an object");
    return;
  }
  if (manifest.schema !== MANIFEST_SCHEMA) issue(`manifest schema is not ${MANIFEST_SCHEMA}`);
  if (manifest.trial !== false) issue("a trial run is not a report (trial must be false)");
  if (typeof manifest.commit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.commit)) {
    issue("commit is not a 40-digit SHA");
  } else if (git(root, ["cat-file", "-t", manifest.commit]).out !== "commit") {
    issue(`commit ${manifest.commit} is not a commit of this repository`);
  }
  if (manifest.corpusSha256 !== context.corpusSha256) {
    issue("corpus SHA-256 differs from corpus-sha256 of PROTOCOL.md");
  }
  if (manifest.protocolSha256 !== context.protocolSha256) {
    issue(
      `protocolSha256 ${String(manifest.protocolSha256)} differs from PROTOCOL.md at ${context.protocolCommit} (${context.protocolSha256}): the report was not measured against the frozen text`,
    );
  }
  if (typeof manifest.binarySha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.binarySha256)) {
    issue("binarySha256 is not the SHA-256 of the binary measured");
  }
  const instrument = object(manifest.instrument);
  const harnessCommit = instrument?.harnessCommit;
  const scriptSha256 = instrument?.scriptSha256;
  if (
    typeof harnessCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(harnessCommit) ||
    typeof scriptSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(scriptSha256)
  ) {
    issue(
      "instrument is not the commit of the harness and the SHA-256 of the instrumentation script",
    );
  }
  // The one identity every raw output of the report must carry (PROTOCOL.md section 10.7).
  const run = {
    binarySha256: manifest.binarySha256,
    harnessCommit,
    scriptSha256,
  };
  for (const message of rejectedLaunchesIssues(manifest.rejectedLaunches)) issue(message);
  // An absent field reads undefined, which is not null: stoppedIssues reports it.
  for (const message of stoppedIssues(manifest.stopped)) issue(message);
  for (const message of checkMachine(
    object(manifest.machine),
    context.machineClass,
    context.classes,
  )) {
    issue(message);
  }
  const entries = Array.isArray(manifest.measures) ? manifest.measures.map(object) : null;
  if (entries === null) {
    issue("measures is not a list");
    return;
  }
  for (const entry of entries) {
    if (entry === null || !specs.some((spec) => spec.measure === entry.measure)) {
      issue(`unknown measure entry ${JSON.stringify(entry?.measure ?? entry)}`);
    }
  }
  for (const spec of specs) {
    const matching = entries.filter((entry) => entry?.measure === spec.measure);
    const entry = matching[0];
    if (matching.length !== 1 || entry === undefined || entry === null) {
      issue(`${spec.id}: ${matching.length} entries for this threshold, exactly 1 required`);
      continue;
    }
    if (entry.threshold !== spec.threshold) {
      issue(
        `${spec.id}: threshold "${String(entry.threshold)}" differs from PROTOCOL.md "${spec.threshold}"`,
      );
      continue;
    }
    const path = rawPath(reportDirectory, entry.raw);
    if (path === null) {
      issue(`${spec.id}: raw path ${JSON.stringify(entry.raw)} is not inside the report directory`);
      continue;
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      issue(`${spec.id}: raw output ${String(entry.raw)} is missing`);
      continue;
    }
    let raw: unknown;
    try {
      raw = readJson(path);
    } catch {
      issue(`${spec.id}: raw output ${String(entry.raw)} is not JSON`);
      continue;
    }
    const evaluation = evaluate(spec, raw);
    if (!evaluation.ok) {
      issue(`${spec.id}: ${evaluation.issue}`);
      continue;
    }
    const recorded = [
      ...measuredWithIssues(spec, raw, run),
      ...framePeriodIssues(spec, entry.framePeriods),
      ...boundGapIssues(spec, entry.boundGap, raw),
    ];
    if (recorded.length > 0) {
      for (const message of recorded) issue(message);
      continue;
    }
    const declared =
      entry.value === null || typeof entry.value === "number"
        ? fromJsonValue(entry.value)
        : Number.NaN;
    if (declared !== evaluation.value || entry.verdict !== evaluation.verdict) {
      issue(
        `${spec.id}: declared ${String(entry.value)} ${String(entry.verdict)}, the raw output gives ${evaluation.value} ${evaluation.verdict}`,
      );
      continue;
    }
    outcome.examined += 1;
    if (evaluation.verdict === "pass") outcome.pass += 1;
    else outcome.fail += 1;
    console.log(
      `check-report: ${name}: ${spec.id}: ${evaluation.verdict} (${evaluation.value}, ${spec.threshold})`,
    );
  }
}

function argumentsOf(argv: readonly string[]): { root: string; reports: string[] } {
  let root = join(import.meta.dir, "..", "..", "..");
  const reports: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name === "--root" || name === "--report") && value !== undefined) {
      if (name === "--root") root = resolve(value);
      else reports.push(resolve(value));
      index += 1;
    } else {
      throw new Error("usage: bun check-report.ts [--root DIR] [--report DIR]...");
    }
  }
  return { root, reports };
}

/**
 * PROTOCOL.md as committed at P, the last commit that changes it (section 10.8):
 * the thresholds, counts and parameters applied are read there, never in the
 * working tree, where an uncommitted edit could move a threshold.
 */
export function protocolAtFreeze(root: string): { commit: string; text: string; sha256: string } {
  const commit = git(root, ["log", "-1", "--format=%H", "--", PROTOCOL_RELATIVE_PATH]).out;
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error("no commit of this repository changes PROTOCOL.md");
  const shown = Bun.spawnSync(["git", "-C", root, "show", `${commit}:${PROTOCOL_RELATIVE_PATH}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (shown.exitCode !== 0) throw new Error(`git show ${commit}:${PROTOCOL_RELATIVE_PATH} failed`);
  const bytes = shown.stdout;
  return {
    commit,
    text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function main(argv: readonly string[]): number {
  const { root, reports: requested } = argumentsOf(argv);
  const outcome: Outcome = { examined: 0, pass: 0, fail: 0, issues: [] };
  const frozen = protocolAtFreeze(root);
  const protocol = frozen.text;
  const specs = measureSpecs(protocol);
  const parameters = seriesParameters(protocol);
  let reports = requested;
  if (reports.length === 0) {
    const directory = join(root, REPORTS_RELATIVE_PATH);
    reports = existsSync(directory)
      ? readdirSync(directory)
          .map((entry) => join(directory, entry))
          .filter((entry) => existsSync(join(entry, "manifest.json")))
      : [];
  }
  if (reports.length === 0) {
    outcome.issues.push(`no report: no manifest.json under ${REPORTS_RELATIVE_PATH}`);
  } else {
    const classes = parseResourceClassManifest(
      readJson(join(root, "toolchains", "notebook-resource-classes.json")),
    );
    for (const report of reports) {
      checkReport(
        root,
        report,
        specs,
        {
          corpusSha256: parameters.corpusSha256,
          machineClass: parameters.machineClass,
          classes,
          protocolSha256: frozen.sha256,
          protocolCommit: frozen.commit,
        },
        outcome,
      );
    }
    outcome.issues.push(...freezeIssues(root));
  }
  for (const message of outcome.issues) console.log(`check-report: incomplete: ${message}`);
  console.log(
    `check-report: ${outcome.examined} thresholds examined of ${specs.length * Math.max(reports.length, 1)} expected in ${reports.length} report(s): ${outcome.pass} pass, ${outcome.fail} fail, ${outcome.issues.length} issue(s)`,
  );
  if (outcome.issues.length > 0) return 2;
  return outcome.fail > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `check-report: incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("check-report: 0 thresholds examined");
    process.exitCode = 2;
  }
}
