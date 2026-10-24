// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Runs the series of PROTOCOL.md in the built shell and writes a report
// directory: `manifest.json` and one raw output per threshold under `raw/`.
//
//   bun tools/qualification/p04-tauri/series/run.ts --out DIR [--trial N] [--only ID,ID] [--binary PATH]
//
// `--out` must not exist. The paquet WP-5 passes `tools/qualification/p04-tauri/reports/<ID>`.
// `--trial N` caps every count at N to tune the harness: the manifest then says
// `trial: true` and check-report.ts refuses it. A measure that cannot be made
// here (no Accessibility permission, a control that fails, a launch that keeps
// being rejected) is written as an `unavailable` raw output with its reason:
// never a zero, never a pass.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LARGE_NOTE_INDEX, LONG_NOTE_INDEX, notePath, writeCorpus } from "../cr10k";
import { compareSnapshots, snapshotDirectory } from "../oracle";
import { exposedProportion, readFocusedText } from "./ax";
import { digestDirectory, editCounts, editPlan, readFiles } from "./corpus";
import {
  type EditPass,
  evaluate,
  RAW_SCHEMA,
  type RawOutput,
  type RoundTripPass,
} from "./evaluate";
import { instrumentationScript, type Plan } from "./instrument";
import { accessibilityTrusted, postCharacter } from "./keys";
import { detectMachine } from "./machine";
import { MANIFEST_SCHEMA, type MeasureEntry, type ReportManifest, toJsonValue } from "./manifest";
import {
  attributeHelpers,
  HELPER_NAMES,
  type ProcessTable,
  readProcessTable,
  rssMib,
} from "./memory";
import {
  type MeasureSpec,
  measureSpecs,
  readProtocol,
  type SeriesParameters,
  seriesParameters,
} from "./protocol";
import { buildSeriesBinary, expectEvent, type Launched, launchShell } from "./shell";
import { frontmostPid, type Rejection, rejection } from "./system";

const REPOSITORY = join(import.meta.dir, "..", "..", "..", "..");
const REPORT_TIMEOUT_MS = 120_000;
const MAX_REJECTIONS = 10;
/** PROTOCOL.md section 10.2: the page blocks 500 ms; a platform timestamp measures at least 250 ms. */
const CONTROL_BLOCK_MS = 500;
const CONTROL_MINIMUM_MS = 250;
const KEY_GAP_MS = 20;

class Unavailable extends Error {}

type RejectionCause = Rejection | "helpers-unattributed";

/** What a launch body returns when its launch is not a sample and is redone. */
class Rejected {
  constructor(readonly cause: RejectionCause) {}
}

interface Context {
  parameters: SeriesParameters;
  binary: string;
  trusted: boolean;
  cap: (count: number) => number;
  rejected: Record<RejectionCause, number>;
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", REPOSITORY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.toString().trim();
}

/** A fresh copy of CR-10k, checked against corpus-sha256 (PROTOCOL.md section 10). */
function freshVault(parameters: SeriesParameters): { vault: string; dispose: () => void } {
  const parent = mkdtempSync(join(tmpdir(), "p04-series-vault-"));
  const vault = join(parent, "vault");
  writeCorpus(vault);
  const { sha256, fileCount } = digestDirectory(vault);
  if (sha256 !== parameters.corpusSha256 || fileCount !== parameters.corpusFiles) {
    rmSync(parent, { recursive: true, force: true });
    throw new Error("the fresh corpus does not match corpus-sha256 of PROTOCOL.md");
  }
  return { vault, dispose: () => rmSync(parent, { recursive: true, force: true }) };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function noteBytes(vault: string, index: number): Uint8Array {
  const bytes = readFiles(vault).get(notePath(index));
  if (bytes === undefined) throw new Error(`the corpus has no ${notePath(index)}`);
  return bytes;
}

/** Keystrokes go to the frontmost window: never type into another application. */
function typeInto(shell: Launched, text: string): Promise<void> {
  if (frontmostPid() !== shell.pid)
    throw new Unavailable("the shell is not the frontmost application");
  return (async () => {
    for (const character of text) {
      postCharacter(character);
      await Bun.sleep(KEY_GAP_MS);
    }
  })();
}

/**
 * One launch with the rejection rule of PROTOCOL.md section 10.7: a launch
 * made with a locked session or a switched-off screen is redone, as is one
 * whose body reports helpers it cannot attribute.
 */
async function withLaunch<T>(
  context: Context,
  vault: string,
  plan: Plan,
  body: (shell: Launched, before: ProcessTable) => Promise<T | Rejected>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_REJECTIONS; attempt += 1) {
    const before = readProcessTable();
    const cause = rejection();
    if (cause !== null) {
      context.rejected[cause] += 1;
      await Bun.sleep(5000);
      continue;
    }
    const shell = launchShell(context.binary, vault, instrumentationScript(plan));
    try {
      const result = await body(shell, before);
      const after = rejection();
      if (after !== null) {
        context.rejected[after] += 1;
        continue;
      }
      if (result instanceof Rejected) {
        context.rejected[result.cause] += 1;
        continue;
      }
      return result;
    } finally {
      await shell.stop();
    }
  }
  throw new Unavailable(`${MAX_REJECTIONS} launches rejected in a row`);
}

async function exitedCleanly(shell: Launched): Promise<void> {
  const code = await Promise.race([shell.exited, Bun.sleep(REPORT_TIMEOUT_MS).then(() => -1)]);
  if (code !== 0) throw new Error(`the shell exited with code ${code}`);
}

async function roundTrip(spec: MeasureSpec, context: Context): Promise<RawOutput> {
  const passes: RoundTripPass[] = [];
  for (let pass = 0; pass < context.cap(spec.count); pass += 1) {
    const { vault, dispose } = freshVault(context.parameters);
    try {
      const reference = snapshotDirectory(vault);
      const paths = [...reference.keys()];
      await withLaunch(
        context,
        vault,
        { mode: "round-trip", paths, saveTimeoutMs: context.parameters.saveTimeoutMs },
        async (shell) => {
          const done = await expectEvent(shell, "done", REPORT_TIMEOUT_MS);
          console.log(
            `series: at-01 round trip pass ${pass}: opened ${String(done.opened)}, refused ${String(done.refused)}`,
          );
          await exitedCleanly(shell);
        },
      );
      const comparison = compareSnapshots(reference, snapshotDirectory(vault));
      const { examined, identical, changed, missing, added } = comparison;
      passes.push({ examined, identical, changed, missing, added });
      console.log(`series: at-01 round trip pass ${pass}: ${identical}/${examined} identical`);
    } finally {
      dispose();
    }
  }
  return { schema: RAW_SCHEMA, kind: "round-trip", passes };
}

async function paragraphEdit(spec: MeasureSpec, context: Context): Promise<RawOutput> {
  if (!context.trusted)
    throw new Unavailable("AXIsProcessTrusted() is false: system keystrokes are dropped");
  const passes: EditPass[] = [];
  let editableFiles = 0;
  for (let pass = 0; pass < context.cap(spec.count); pass += 1) {
    const { vault, dispose } = freshVault(context.parameters);
    try {
      const before = readFiles(vault);
      const plan = editPlan(before);
      editableFiles = plan.items.length;
      const items = plan.items.map(({ path, offset }) => ({ path, offset }));
      const states: Record<string, number> = {};
      await withLaunch(
        context,
        vault,
        {
          mode: "edit",
          items,
          text: context.parameters.at01EditText,
          saveTimeoutMs: context.parameters.saveTimeoutMs,
        },
        async (shell) => {
          for (;;) {
            const event = await shell.next(REPORT_TIMEOUT_MS);
            if (event.type === "ready-edit") await typeInto(shell, context.parameters.at01EditText);
            else if (event.type === "edited")
              states[String(event.state)] = (states[String(event.state)] ?? 0) + 1;
            else if (event.type === "done") break;
            else throw new Error(`unexpected report ${event.type}`);
          }
          await exitedCleanly(shell);
        },
      );
      const counts = editCounts(before, readFiles(vault), plan);
      passes.push(counts);
      console.log(
        `series: at-01 edit pass ${pass}: ${JSON.stringify(counts)} states ${JSON.stringify(states)}`,
      );
    } finally {
      dispose();
    }
  }
  return { schema: RAW_SCHEMA, kind: "paragraph-edit", editableFiles, passes };
}

async function keystrokeLatency(
  spec: MeasureSpec,
  context: Context,
  noteIndex: number,
): Promise<RawOutput> {
  if (!context.trusted)
    throw new Unavailable("AXIsProcessTrusted() is false: system keystrokes are dropped");
  const { vault, dispose } = freshVault(context.parameters);
  try {
    const count = context.cap(spec.count);
    const plan: Plan = {
      mode: "latency",
      path: notePath(noteIndex),
      cycle: context.parameters.at02TypedCycle,
      count,
      pauseMs: context.parameters.at02PauseMs,
      timeoutMs: context.parameters.keystrokeTimeoutMs,
      controlBlockMs: CONTROL_BLOCK_MS,
    };
    const samples = await withLaunch(context, vault, plan, async (shell) => {
      const ready = await expectEvent(shell, "ready-control", REPORT_TIMEOUT_MS);
      await typeInto(shell, String(ready.character));
      const control = await expectEvent(shell, "control", REPORT_TIMEOUT_MS);
      if (typeof control.latency !== "number" || control.latency < CONTROL_MINIMUM_MS) {
        throw new Unavailable(
          `start-bound control failed: ${String(control.latency)} ms for a 500 ms block`,
        );
      }
      const values: (number | null)[] = [];
      for (let k = 0; k < count; k += 1) {
        const key = await expectEvent(shell, "ready-key", REPORT_TIMEOUT_MS);
        await typeInto(shell, String(key.character));
        const measured = await expectEvent(shell, "key", REPORT_TIMEOUT_MS);
        const latency = measured.latency;
        if (latency !== null && (typeof latency !== "number" || latency < 0)) {
          throw new Error(`instrument error: latency ${String(latency)}`);
        }
        values.push(latency);
      }
      await expectEvent(shell, "done", REPORT_TIMEOUT_MS);
      await exitedCleanly(shell);
      return values;
    });
    return { schema: RAW_SCHEMA, kind: "latency", unit: "ms", samples };
  } finally {
    dispose();
  }
}

async function firstOpening(spec: MeasureSpec, context: Context): Promise<RawOutput> {
  const samples: number[] = [];
  for (let launch = 0; launch < context.cap(spec.count); launch += 1) {
    const { vault, dispose } = freshVault(context.parameters);
    try {
      const firstLine = decode(noteBytes(vault, LARGE_NOTE_INDEX)).split("\n")[0] ?? "";
      const latency = await withLaunch(
        context,
        vault,
        { mode: "open", path: notePath(LARGE_NOTE_INDEX), firstLine },
        async (shell) => {
          const open = await expectEvent(shell, "open", REPORT_TIMEOUT_MS);
          await exitedCleanly(shell);
          if (typeof open.latency !== "number" || open.latency < 0)
            throw new Error("instrument error: open latency");
          return open.latency;
        },
      );
      samples.push(latency);
      console.log(`series: nfr-03 launch ${launch}: ${latency.toFixed(2)} ms`);
    } finally {
      dispose();
    }
  }
  return { schema: RAW_SCHEMA, kind: "latency", unit: "ms", samples };
}

async function residentMemory(spec: MeasureSpec, context: Context): Promise<RawOutput> {
  const launches: { peakMib: number; samples: number }[] = [];
  const period = context.parameters.nfr10SamplePeriodMs;
  for (let launch = 0; launch < context.cap(spec.count); launch += 1) {
    const { vault, dispose } = freshVault(context.parameters);
    try {
      const plan: Plan = {
        mode: "memory",
        path: notePath(LARGE_NOTE_INDEX),
        holdMs: context.parameters.nfr10HoldMs,
        marksTimeoutMs: context.parameters.saveTimeoutMs,
      };
      const reading = await withLaunch(context, vault, plan, async (shell, before) => {
        let peakMib = 0;
        let readings = 0;
        // Read inside the sampler: an object, so the type is not narrowed to its initial null.
        const reads: { locked: Rejection | null } = { locked: null };
        const seen: ProcessTable = new Map();
        let running = true;
        const sampler = (async () => {
          while (running) {
            const table = readProcessTable();
            if (!table.has(shell.pid)) break;
            const helpers = [...table].filter(
              ([pid, row]) =>
                !before.has(pid) && (HELPER_NAMES as readonly string[]).includes(row.name),
            );
            for (const [pid, row] of helpers) seen.set(pid, row);
            peakMib = Math.max(peakMib, rssMib(table, [shell.pid, ...helpers.map(([pid]) => pid)]));
            readings += 1;
            reads.locked ??= rejection();
            await Bun.sleep(period);
          }
        })();
        try {
          await expectEvent(shell, "steady", REPORT_TIMEOUT_MS);
          await expectEvent(shell, "done", REPORT_TIMEOUT_MS + context.parameters.nfr10HoldMs);
          await exitedCleanly(shell);
        } finally {
          running = false;
          await sampler;
        }
        if (reads.locked !== null) return new Rejected(reads.locked);
        return attributeHelpers(before, seen).ok
          ? { peakMib, samples: readings }
          : new Rejected("helpers-unattributed");
      });
      launches.push(reading);
      console.log(
        `series: nfr-10 launch ${launch}: peak ${reading.peakMib.toFixed(1)} Mio over ${reading.samples} readings`,
      );
    } finally {
      dispose();
    }
  }
  return { schema: RAW_SCHEMA, kind: "memory", unit: "Mio", launches };
}

async function accessibility(_spec: MeasureSpec, context: Context): Promise<RawOutput> {
  if (!context.trusted)
    throw new Unavailable("AXIsProcessTrusted() is false: the accessibility API refuses the read");
  const { vault, dispose } = freshVault(context.parameters);
  try {
    const reference = decode(noteBytes(vault, LARGE_NOTE_INDEX));
    const read = await withLaunch(
      context,
      vault,
      { mode: "accessibility", path: notePath(LARGE_NOTE_INDEX) },
      async (shell) => {
        await expectEvent(shell, "ready-ax", REPORT_TIMEOUT_MS);
        return readFocusedText(shell.pid);
      },
    );
    const { total, matching } = exposedProportion(reference, read.text);
    console.log(
      `series: accessibility ${read.role} via ${read.source}: ${matching}/${total} UTF-16 units`,
    );
    return { schema: RAW_SCHEMA, kind: "accessibility", role: read.role, total, matching };
  } finally {
    dispose();
  }
}

function measure(spec: MeasureSpec, context: Context): Promise<RawOutput> {
  switch (spec.id) {
    case "at-01-round-trip":
      return roundTrip(spec, context);
    case "at-01-paragraph-edit":
      return paragraphEdit(spec, context);
    case "at-02-5000-lines":
      return keystrokeLatency(spec, context, LONG_NOTE_INDEX);
    case "at-02-1-mib":
      return keystrokeLatency(spec, context, LARGE_NOTE_INDEX);
    case "nfr-03":
      return firstOpening(spec, context);
    case "nfr-10":
      return residentMemory(spec, context);
    case "accessibility":
      return accessibility(spec, context);
  }
}

interface Options {
  out: string;
  trial: number | null;
  only: string[] | null;
  binary: string | null;
}

function options(argv: readonly string[]): Options {
  const parsed: Options = { out: "", trial: null, only: null, binary: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${String(name)} needs a value`);
    if (name === "--out") parsed.out = resolve(value);
    else if (name === "--trial" && /^[1-9][0-9]*$/.test(value)) parsed.trial = Number(value);
    else if (name === "--only") parsed.only = value.split(",");
    else if (name === "--binary") parsed.binary = resolve(value);
    else throw new Error(`unknown option ${String(name)}`);
  }
  if (parsed.out === "") throw new Error("--out DIR is required");
  return parsed;
}

async function main(argv: readonly string[]): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("series: unavailable: the shell runs on macOS (WKWebView)");
    return 2;
  }
  const chosen = options(argv);
  if (existsSync(chosen.out))
    throw new Error(`${chosen.out} exists: a report directory is written once`);
  const protocol = readProtocol(REPOSITORY);
  const parameters = seriesParameters(protocol);
  const specs = measureSpecs(protocol).filter(
    (spec) => chosen.only === null || chosen.only.includes(spec.id),
  );
  const trial = chosen.trial !== null || chosen.only !== null;
  const commit = git(["rev-parse", "HEAD"]);
  if (!trial && git(["status", "--porcelain"]) !== "") {
    throw new Error("the working tree is not clean: the binary would not be the commit it names");
  }
  const machine = detectMachine(REPOSITORY, parameters.machineClass);
  const context: Context = {
    parameters,
    binary: chosen.binary ?? buildSeriesBinary(REPOSITORY),
    trusted: accessibilityTrusted(),
    cap: (count) => (chosen.trial === null ? count : Math.min(count, chosen.trial)),
    rejected: { "session-locked": 0, "display-asleep": 0, "helpers-unattributed": 0 },
  };
  console.log(
    `series: machine ${machine.class}, commit ${commit}, accessibility trusted ${context.trusted}`,
  );
  mkdirSync(join(chosen.out, "raw"), { recursive: true });
  const measures: MeasureEntry[] = [];
  for (const spec of specs) {
    let raw: RawOutput;
    try {
      raw = await measure(spec, context);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`series: ${spec.id}: unavailable: ${reason}`);
      raw = { schema: RAW_SCHEMA, kind: "unavailable", reason };
    }
    const path = `raw/${spec.id}.json`;
    writeFileSync(join(chosen.out, path), `${JSON.stringify(raw, null, 2)}\n`);
    const evaluation = evaluate(spec, raw);
    measures.push({
      id: spec.id,
      measure: spec.measure,
      threshold: spec.threshold,
      raw: path,
      value: evaluation.ok ? toJsonValue(evaluation.value) : null,
      verdict: evaluation.ok ? evaluation.verdict : "fail",
    });
    console.log(
      `series: ${spec.id}: ${evaluation.ok ? `${evaluation.verdict} (${evaluation.value})` : `incomplete (${evaluation.issue})`}`,
    );
  }
  const manifest: ReportManifest = {
    schema: MANIFEST_SCHEMA,
    trial,
    commit,
    createdAt: new Date().toISOString(),
    machine,
    corpusSha256: parameters.corpusSha256,
    rejectedLaunches: context.rejected,
    measures,
  };
  writeFileSync(join(chosen.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `series: ${measures.length} measure(s) written to ${chosen.out}; rejected launches ${JSON.stringify(context.rejected)}`,
  );
  return 0;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`series: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    },
  );
}
