// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Runs the series of PROTOCOL.md in the built shell and writes a report
// directory: `manifest.json` and one raw output per threshold under `raw/`.
//
//   bun tools/qualification/p04-tauri/series/run.ts --out DIR [--trial N] [--only ID,ID] [--binary PATH]
//
// `--out` must not exist. The paquet WP-5 passes `tools/qualification/p04-tauri/reports/<ID>`.
// `--trial N` caps every count at N, `--only` makes a subset of the measures and
// `--binary` measures another binary than the one built from the commit: each
// makes a trial, the manifest says `trial: true` and check-report.ts refuses it.
// A pass, a configuration or a launch interrupted for a cause of PROTOCOL.md
// section 10.7 is recorded in the raw output of its measure and redone
// (`attempts.ts`); three rejections or interruptions of one cause in a row stop
// the series, recorded in the manifest without a verdict. A measure that cannot
// be made here (no Accessibility permission, a start-bound control that fails)
// is written as an `unavailable` raw output with its reason: never a zero,
// never a pass.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LARGE_NOTE_INDEX, LONG_NOTE_INDEX, notePath, writeCorpus } from "../cr10k";
import { at01Series } from "./at01";
import {
  Interrupted,
  type Interruption,
  SeriesStopped,
  Streak,
  Unavailable,
  untilCompleted,
} from "./attempts";
import { ffiSource } from "./ax";
import { measureAccessibility } from "./ax-read";
import { checkStartBoundControl } from "./control";
import { digestDirectory, editorLines, readFiles } from "./corpus";
import { evaluate, type MemoryLaunch, type RawBody, type RawOutput } from "./evaluate";
import { instrumentationScript, type Plan, SCRIPT_SHA256 } from "./instrument";
import { accessibilityTrusted, postCharacter } from "./keys";
import { Rejected, withLaunch } from "./launch";
import { detectMachine } from "./machine";
import {
  defectOf,
  type FramePeriod,
  type GapSummary,
  type MeasuredWith,
  type MeasureEntry,
  type RejectionCause,
  type SeriesStop,
  toJsonValue,
} from "./manifest";
import {
  attributeHelpers,
  HELPER_NAMES,
  type ProcessTable,
  readProcessTable,
  rssMib,
  webKitHelpers,
} from "./memory";
import { isTrial, parseOptions } from "./options";
import {
  type MeasureId,
  type MeasureSpec,
  measureSpecs,
  PROTOCOL_RELATIVE_PATH,
  type SeriesParameters,
  seriesParameters,
} from "./protocol";
import { framePeriodOf, manifestOf, measuredWithOf, rawOf } from "./report";
import { realClock, sampleOnDeadlines } from "./sampler";
import { buildSeriesBinary, expectEvent, type Launched, launchShell, shellExited } from "./shell";
import { summary } from "./stats";
import { frontmostPid, rejection } from "./system";

const REPOSITORY = join(import.meta.dir, "..", "..", "..", "..");
const REPORT_TIMEOUT_MS = 120_000;
/** Wait before reading again when the session is locked or the screen off. */
const REJECTION_PAUSE_MS = 5000;
/**
 * NFR-03: the lines of the note the plan carries, far more than the visible area
 * holds; a visible area that holds more is an instrument error, never "shown".
 */
const OPEN_PLAN_LINES = 500;

interface Context {
  parameters: SeriesParameters;
  binary: string;
  measuredWith: MeasuredWith;
  trusted: boolean;
  cap: (count: number) => number;
  rejected: Record<RejectionCause, number>;
  streak: Streak;
}

/** What a measure gives: its raw output, its frame periods and, for AT-02, its gap summary. */
interface Measured {
  raw: RawOutput;
  framePeriods: FramePeriod[];
  boundGap: GapSummary | null;
}

interface Made {
  body: RawBody;
  framePeriods: FramePeriod[];
  boundGap: GapSummary | null;
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

/**
 * System keystrokes, one per character (PROTOCOL.md section 10.2). Just before
 * each one, the exit of the shell is read, then the frontmost application
 * (section 10.7): a dead shell is never read as not frontmost.
 */
async function typeInto(shell: Launched, text: string, gapMs: number): Promise<void> {
  let first = true;
  for (const character of text) {
    if (!first) await Bun.sleep(gapMs);
    first = false;
    const code = shell.exitCode();
    if (code !== null) throw shellExited(code);
    const front = frontmostPid();
    if (front !== shell.pid) {
      throw new Interrupted(
        "shell-not-frontmost",
        `pid ${front} is frontmost, the shell is ${shell.pid}`,
      );
    }
    postCharacter(character);
  }
}

/** One launch with the rejection rule of PROTOCOL.md section 10.7 (`launch.ts`). */
function launch<T>(
  context: Context,
  vault: string,
  plan: Plan,
  unit: string,
  body: (shell: Launched, before: ProcessTable) => Promise<T | Rejected>,
): Promise<T> {
  return withLaunch(
    {
      rejection,
      readTable: readProcessTable,
      launch: () => launchShell(context.binary, vault, instrumentationScript(plan)),
      pause: () => Bun.sleep(REJECTION_PAUSE_MS),
    },
    { rejected: context.rejected, streak: context.streak, unit },
    body,
  );
}

/** The planned end of a launch: a clean exit, else the shell left before it. */
async function exitedCleanly(shell: Launched): Promise<void> {
  const code = await Promise.race([shell.exited, Bun.sleep(REPORT_TIMEOUT_MS).then(() => null)]);
  if (code === null) throw new Error("the shell did not exit at the end of the launch");
  if (code !== 0) throw shellExited(code);
}

async function framesOf(shell: Launched, intervals: number): Promise<FramePeriod> {
  return framePeriodOf(await expectEvent(shell, "frames", REPORT_TIMEOUT_MS), intervals);
}

function unavailable(error: unknown): RawBody {
  return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
}

const notMeasured = (raw: RawOutput): Measured => ({ raw, framePeriods: [], boundGap: null });

// ---- AT-01: both lines come from the same passes (PROTOCOL.md section 10.5).
async function at01(
  roundTripSpec: MeasureSpec | undefined,
  editSpec: MeasureSpec | undefined,
  context: Context,
): Promise<Map<MeasureId, Measured>> {
  const results = new Map<MeasureId, Measured>();
  const interruptions: Interruption[] = [];
  const spec = roundTripSpec ?? editSpec;
  if (spec === undefined) return results;
  const all = (body: RawBody) => {
    for (const chosen of [roundTripSpec, editSpec]) {
      if (chosen !== undefined)
        results.set(
          chosen.id,
          notMeasured(rawOf(chosen, body, interruptions, context.measuredWith)),
        );
    }
  };
  try {
    if (editSpec !== undefined && !context.trusted) {
      throw new Unavailable("AXIsProcessTrusted() is false: system keystrokes are dropped");
    }
    const series = await at01Series(
      context.cap(spec.count),
      editSpec !== undefined,
      {
        freshCopy: () => freshVault(context.parameters),
        roundTripLaunch: (vault, paths, unit) =>
          launch(
            context,
            vault,
            { mode: "round-trip", paths, saveTimeoutMs: context.parameters.saveTimeoutMs },
            unit,
            async (shell) => {
              const done = await expectEvent(shell, "done", REPORT_TIMEOUT_MS);
              console.log(
                `series: ${unit} round trip: opened ${String(done.opened)}, refused ${String(done.refused)}`,
              );
              await exitedCleanly(shell);
            },
          ),
        editLaunch: (vault, plan, unit) =>
          launch(
            context,
            vault,
            {
              mode: "edit",
              items: plan.items.map(({ path, offset }) => ({ path, offset })),
              text: context.parameters.at01EditText,
              saveTimeoutMs: context.parameters.saveTimeoutMs,
            },
            unit,
            async (shell) => {
              const states: Record<string, number> = {};
              for (;;) {
                const event = await shell.next(REPORT_TIMEOUT_MS);
                if (event.type === "ready-edit") {
                  await typeInto(
                    shell,
                    context.parameters.at01EditText,
                    context.parameters.at01KeyGapMs,
                  );
                } else if (event.type === "edited") {
                  states[String(event.state)] = (states[String(event.state)] ?? 0) + 1;
                } else if (event.type === "done") break;
                else if (event.type !== "progress")
                  throw new Error(`unexpected report ${event.type}`);
              }
              console.log(`series: ${unit} edit: save states ${JSON.stringify(states)}`);
              await exitedCleanly(shell);
            },
          ),
      },
      interruptions,
      context.streak,
    );
    if (roundTripSpec !== undefined) {
      const body: RawBody = { kind: "round-trip", passes: series.roundTrip };
      results.set(
        roundTripSpec.id,
        notMeasured(rawOf(roundTripSpec, body, interruptions, context.measuredWith)),
      );
    }
    if (editSpec !== undefined) {
      const body: RawBody = {
        kind: "paragraph-edit",
        editableFiles: series.editableFiles,
        passes: series.edit,
      };
      results.set(
        editSpec.id,
        notMeasured(rawOf(editSpec, body, interruptions, context.measuredWith)),
      );
    }
  } catch (error) {
    if (error instanceof SeriesStopped) {
      all({ kind: "unavailable", reason: error.message });
      throw error;
    }
    all(unavailable(error));
  }
  return results;
}

// ---- AT-02: one launch per configuration (PROTOCOL.md section 10.2).
async function keystrokeLatency(
  spec: MeasureSpec,
  context: Context,
  noteIndex: number,
  interruptions: Interruption[],
): Promise<Made> {
  if (!context.trusted)
    throw new Unavailable("AXIsProcessTrusted() is false: system keystrokes are dropped");
  const count = context.cap(spec.count);
  const plan: Plan = {
    mode: "latency",
    path: notePath(noteIndex),
    cycle: context.parameters.at02TypedCycle,
    count,
    pauseMs: context.parameters.at02PauseMs,
    timeoutMs: context.parameters.keystrokeTimeoutMs,
    controlBlockMs: context.parameters.timestampControlBlockMs,
    frameIntervals: context.parameters.framePeriodIntervals,
  };
  const unit = `${spec.id} configuration`;
  const made = await untilCompleted(
    unit,
    async () => {
      const { vault, dispose } = freshVault(context.parameters);
      try {
        return await launch(context, vault, plan, unit, async (shell) => {
          const frames = await framesOf(shell, context.parameters.framePeriodIntervals);
          const ready = await expectEvent(shell, "ready-control", REPORT_TIMEOUT_MS);
          await typeInto(shell, String(ready.character), 0);
          const control = await expectEvent(shell, "control", REPORT_TIMEOUT_MS);
          checkStartBoundControl(control.latency, context.parameters);
          const samples: (number | null)[] = [];
          const gapsMs: (number | null)[] = [];
          for (let k = 0; k < count; k += 1) {
            const key = await expectEvent(shell, "ready-key", REPORT_TIMEOUT_MS);
            await typeInto(shell, String(key.character), 0);
            const measured = await expectEvent(shell, "key", REPORT_TIMEOUT_MS);
            const { latency, gap } = measured;
            if (latency === null) {
              samples.push(null);
              gapsMs.push(null);
              continue;
            }
            // A negative difference is an instrument error: the configuration is redone.
            if (typeof latency !== "number" || latency < 0 || typeof gap !== "number" || gap < 0) {
              throw new Interrupted(
                "instrument-error",
                `keystroke ${k}: latency ${String(latency)}, gap ${String(gap)}`,
              );
            }
            samples.push(latency);
            gapsMs.push(gap);
          }
          await expectEvent(shell, "done", REPORT_TIMEOUT_MS);
          await exitedCleanly(shell);
          return { samples, gapsMs, frames };
        });
      } finally {
        dispose();
      }
    },
    interruptions,
    context.streak,
  );
  const observed = made.gapsMs.filter((gap): gap is number => gap !== null);
  return {
    body: { kind: "latency", unit: "ms", samples: made.samples, gapsMs: made.gapsMs },
    framePeriods: [made.frames],
    boundGap: summary(observed),
  };
}

// ---- NFR-03: first opening of the 1 MiB note (PROTOCOL.md section 10.3).
async function firstOpening(
  spec: MeasureSpec,
  context: Context,
  interruptions: Interruption[],
): Promise<Made> {
  const samples: (number | null)[] = [];
  const callbacks: (number | null)[] = [];
  const framePeriods: FramePeriod[] = [];
  for (let index = 0; index < context.cap(spec.count); index += 1) {
    const unit = `nfr-03 launch ${index}`;
    const sample = await untilCompleted(
      unit,
      async () => {
        const { vault, dispose } = freshVault(context.parameters);
        try {
          const lines = editorLines(decode(noteBytes(vault, LARGE_NOTE_INDEX)));
          const plan: Plan = {
            mode: "open",
            path: notePath(LARGE_NOTE_INDEX),
            firstLines: lines.slice(0, OPEN_PLAN_LINES),
            lineCount: lines.length,
            // Section 10.3: not observed nfr-03-end-timeout-ms after the start bound, +oo.
            timeoutMs: context.parameters.nfr03EndTimeoutMs,
            frameIntervals: context.parameters.framePeriodIntervals,
          };
          return await launch(context, vault, plan, unit, async (shell) => {
            const frames = await framesOf(shell, context.parameters.framePeriodIntervals);
            const open = await expectEvent(shell, "open", REPORT_TIMEOUT_MS);
            await exitedCleanly(shell);
            if (open.latency === null && open.callbacks === null) {
              return { latency: null, callbacks: null, frames };
            }
            if (
              typeof open.latency !== "number" ||
              open.latency < 0 ||
              typeof open.callbacks !== "number"
            ) {
              throw new Interrupted(
                "instrument-error",
                `open latency ${String(open.latency)}, callbacks ${String(open.callbacks)}`,
              );
            }
            return { latency: open.latency, callbacks: open.callbacks, frames };
          });
        } finally {
          dispose();
        }
      },
      interruptions,
      context.streak,
    );
    samples.push(sample.latency);
    callbacks.push(sample.callbacks);
    framePeriods.push(sample.frames);
    console.log(
      `series: ${unit}: ${String(sample.latency)} ms after ${String(sample.callbacks)} callbacks`,
    );
  }
  return {
    body: { kind: "latency", unit: "ms", samples, callbacks },
    framePeriods,
    boundGap: null,
  };
}

// ---- NFR-10: resident memory over a launch (PROTOCOL.md section 10.4).
async function residentMemory(
  spec: MeasureSpec,
  context: Context,
  interruptions: Interruption[],
): Promise<Made> {
  const launches: MemoryLaunch[] = [];
  const plan: Plan = {
    mode: "memory",
    path: notePath(LARGE_NOTE_INDEX),
    holdMs: context.parameters.nfr10HoldMs,
    marksTimeoutMs: context.parameters.saveTimeoutMs,
  };
  for (let index = 0; index < context.cap(spec.count); index += 1) {
    const unit = `nfr-10 launch ${index}`;
    const launched = await untilCompleted(
      unit,
      async () => {
        const { vault, dispose } = freshVault(context.parameters);
        try {
          return await launch(context, vault, plan, unit, async (shell, before) => {
            let peakMib = 0;
            // Read inside the sampler: an object, so the type is not narrowed to its initial null.
            const reads: { cause: RejectionCause | null } = { cause: null };
            const seen: ProcessTable = new Map();
            let running = true;
            const sampler = sampleOnDeadlines({
              t0: shell.startedAt,
              periodMs: context.parameters.nfr10SamplePeriodMs,
              clock: realClock,
              running: () => running,
              read: () => {
                const table = readProcessTable();
                if (!table.has(shell.pid)) return false;
                const helpers = [...table].filter(
                  ([pid, row]) =>
                    !before.has(pid) && (HELPER_NAMES as readonly string[]).includes(row.name),
                );
                for (const [pid, row] of helpers) seen.set(pid, row);
                peakMib = Math.max(
                  peakMib,
                  rssMib(table, [shell.pid, ...helpers.map(([pid]) => pid)]),
                );
                reads.cause ??= rejection();
                return true;
              },
            });
            try {
              await expectEvent(shell, "steady", REPORT_TIMEOUT_MS);
              await expectEvent(shell, "done", REPORT_TIMEOUT_MS + context.parameters.nfr10HoldMs);
              await exitedCleanly(shell);
            } catch (error) {
              running = false;
              await sampler.catch(() => undefined);
              throw error;
            }
            running = false;
            const sampling = await sampler;
            if (reads.cause !== null) return new Rejected(reads.cause);
            if (!attributeHelpers(before, seen).ok) return new Rejected("helpers-unattributed");
            const reading: MemoryLaunch = {
              peakMib,
              samples: sampling.readings,
              missedTicks: sampling.missedTicks,
              medianReadingMs: sampling.medianReadingMs,
            };
            return reading;
          });
        } finally {
          dispose();
        }
      },
      interruptions,
      context.streak,
    );
    launches.push(launched);
    console.log(
      `series: ${unit}: peak ${launched.peakMib.toFixed(1)} Mio over ${launched.samples} readings, ${launched.missedTicks} deadlines skipped`,
    );
  }
  return { body: { kind: "memory", unit: "Mio", launches }, framePeriods: [], boundGap: null };
}

// ---- Accessibility (PROTOCOL.md section 10.6).
async function accessibility(context: Context, interruptions: Interruption[]): Promise<Made> {
  if (!context.trusted)
    throw new Unavailable("AXIsProcessTrusted() is false: the accessibility API refuses the read");
  const unit = "accessibility launch";
  const measure = await untilCompleted(
    unit,
    async () => {
      const { vault, dispose } = freshVault(context.parameters);
      try {
        const text = decode(noteBytes(vault, LARGE_NOTE_INDEX));
        return await launch(
          context,
          vault,
          { mode: "accessibility", path: notePath(LARGE_NOTE_INDEX) },
          unit,
          async (shell) => {
            await expectEvent(shell, "ready-ax", REPORT_TIMEOUT_MS);
            const source = ffiSource(shell.pid, () => shell.exitCode());
            try {
              return measureAccessibility(source, text, context.parameters.axStringRangeChars);
            } finally {
              source.dispose();
            }
          },
        );
      } finally {
        dispose();
      }
    },
    interruptions,
    context.streak,
  );
  console.log(
    `series: accessibility: copy found ${measure.found} after ${measure.visited} elements, reading ${String(measure.chosen)}: ${measure.matching}/${measure.total} UTF-16 units`,
  );
  return { body: { kind: "accessibility", ...measure }, framePeriods: [], boundGap: null };
}

async function measureOne(spec: MeasureSpec, context: Context): Promise<Measured> {
  const interruptions: Interruption[] = [];
  try {
    let made: Made;
    switch (spec.id) {
      case "at-02-5000-lines":
        made = await keystrokeLatency(spec, context, LONG_NOTE_INDEX, interruptions);
        break;
      case "at-02-1-mib":
        made = await keystrokeLatency(spec, context, LARGE_NOTE_INDEX, interruptions);
        break;
      case "nfr-03":
        made = await firstOpening(spec, context, interruptions);
        break;
      case "nfr-10":
        made = await residentMemory(spec, context, interruptions);
        break;
      case "accessibility":
        made = await accessibility(context, interruptions);
        break;
      case "at-01-round-trip":
      case "at-01-paragraph-edit":
        throw new Error(`${spec.id} is made by the AT-01 passes`);
    }
    return {
      raw: rawOf(spec, made.body, interruptions, context.measuredWith),
      framePeriods: made.framePeriods,
      boundGap: made.boundGap,
    };
  } catch (error) {
    const raw = rawOf(spec, unavailable(error), interruptions, context.measuredWith);
    if (error instanceof SeriesStopped) throw new StoppedWith(error, raw);
    return notMeasured(raw);
  }
}

/** A stop of the series, with the raw output of the measure it interrupted. */
class StoppedWith extends Error {
  constructor(
    readonly stop: SeriesStopped,
    readonly raw: RawOutput,
  ) {
    super(stop.message);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (process.platform !== "darwin") {
    console.error("series: unavailable: the shell runs on macOS (WKWebView)");
    return 2;
  }
  const chosen = parseOptions(argv);
  if (existsSync(chosen.out))
    throw new Error(`${chosen.out} exists: a report directory is written once`);
  // The bytes the counts, thresholds and parameters are read from: their SHA-256
  // goes into the manifest (PROTOCOL.md section 10.8).
  const protocolBytes = new Uint8Array(readFileSync(join(REPOSITORY, PROTOCOL_RELATIVE_PATH)));
  const protocol = new TextDecoder("utf-8", { fatal: true }).decode(protocolBytes);
  const parameters = seriesParameters(protocol);
  const specs = measureSpecs(protocol).filter(
    (spec) => chosen.only === null || chosen.only.includes(spec.id),
  );
  const trial = isTrial(chosen);
  const commit = git(["rev-parse", "HEAD"]);
  if (!trial && git(["status", "--porcelain"]) !== "") {
    throw new Error("the working tree is not clean: the binary would not be the commit it names");
  }
  // PROTOCOL.md section 10.4: no other application using WebKit is open during the series.
  const foreign = webKitHelpers(readProcessTable());
  if (foreign.length > 0) {
    const message = `${foreign.length} WebKit helper process(es) already run (pids ${foreign.join(", ")}): close the application that uses WebKit`;
    if (!trial) throw new Error(message);
    console.log(`series: trial despite: ${message}`);
  }
  const machine = detectMachine(REPOSITORY, parameters.machineClass);
  const binary = chosen.binary ?? buildSeriesBinary(REPOSITORY);
  const context: Context = {
    parameters,
    binary,
    // PROTOCOL.md section 10.7: the binary and the instrument of every sample of this run.
    measuredWith: measuredWithOf(binary, commit, SCRIPT_SHA256),
    trusted: accessibilityTrusted(),
    cap: (count) => (chosen.trial === null ? count : Math.min(count, chosen.trial)),
    rejected: { "session-locked": 0, "display-asleep": 0, "helpers-unattributed": 0 },
    streak: new Streak(parameters.seriesStopConsecutive),
  };
  console.log(
    `series: machine ${machine.class}, commit ${commit}, trial ${trial}, accessibility trusted ${context.trusted}`,
  );
  mkdirSync(join(chosen.out, "raw"), { recursive: true });
  const byId = (id: MeasureId) => specs.find((spec) => spec.id === id);
  const results = new Map<MeasureId, Measured>();
  let stopped: SeriesStop | null = null;
  const stopWith = (error: SeriesStopped) => {
    stopped = { cause: error.cause, defect: defectOf(error.cause), unit: error.unit };
    console.log(`series: ${error.message}, a defect of the ${defectOf(error.cause)}; no verdict`);
  };
  try {
    for (const [id, measured] of await at01(
      byId("at-01-round-trip"),
      byId("at-01-paragraph-edit"),
      context,
    )) {
      results.set(id, measured);
    }
  } catch (error) {
    if (!(error instanceof SeriesStopped)) throw error;
    stopWith(error);
  }
  const measures: MeasureEntry[] = [];
  for (const spec of specs) {
    let measured = results.get(spec.id);
    if (measured === undefined && stopped === null) {
      try {
        measured = await measureOne(spec, context);
      } catch (error) {
        if (!(error instanceof StoppedWith)) throw error;
        stopWith(error.stop);
        measured = notMeasured(error.raw);
      }
    }
    measured ??= notMeasured(
      rawOf(
        spec,
        { kind: "unavailable", reason: "the series stopped before this measure" },
        [],
        context.measuredWith,
      ),
    );
    const path = `raw/${spec.id}.json`;
    writeFileSync(join(chosen.out, path), `${JSON.stringify(measured.raw, null, 2)}\n`);
    const evaluation = evaluate(spec, measured.raw);
    measures.push({
      id: spec.id,
      measure: spec.measure,
      threshold: spec.threshold,
      raw: path,
      value: evaluation.ok ? toJsonValue(evaluation.value) : null,
      verdict: evaluation.ok ? evaluation.verdict : "fail",
      framePeriods: measured.framePeriods,
      boundGap: measured.boundGap,
    });
    console.log(
      `series: ${spec.id}: ${evaluation.ok ? `${evaluation.verdict} (${evaluation.value})` : `incomplete (${evaluation.issue})`}`,
    );
  }
  const manifest = manifestOf({
    trial,
    commit,
    machine,
    corpusSha256: parameters.corpusSha256,
    protocolBytes,
    measuredWith: context.measuredWith,
    rejectedLaunches: context.rejected,
    stopped,
    measures,
    createdAt: new Date(),
  });
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
