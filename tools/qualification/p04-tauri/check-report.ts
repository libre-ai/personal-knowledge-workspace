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
// machine class, the corpus SHA-256, and the freeze of PROTOCOL.md (section
// 10.8).
//
// Exit 0: every threshold examined and green. Exit 1: complete, at least one
// threshold red. Exit 2: incomplete (no report, a missing or contradicted raw
// output, a broken freeze...): nothing can be concluded. The number of
// thresholds examined is printed in every case.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  type NotebookResourceClassManifest,
  parseResourceClassManifest,
  selectResourceClass,
} from "../notebook-core-v2/resource-class";
import { evaluate } from "./series/evaluate";
import { fromJsonValue, MANIFEST_SCHEMA } from "./series/manifest";
import {
  type MeasureSpec,
  measureSpecs,
  PROTOCOL_RELATIVE_PATH,
  seriesParameters,
} from "./series/protocol";

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

function checkReport(
  root: string,
  reportDirectory: string,
  specs: readonly MeasureSpec[],
  context: { corpusSha256: string; machineClass: string; classes: NotebookResourceClassManifest },
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

export function main(argv: readonly string[]): number {
  const { root, reports: requested } = argumentsOf(argv);
  const outcome: Outcome = { examined: 0, pass: 0, fail: 0, issues: [] };
  const protocol = readFileSync(join(root, PROTOCOL_RELATIVE_PATH), "utf8");
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
