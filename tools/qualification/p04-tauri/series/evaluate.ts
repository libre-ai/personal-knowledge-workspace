// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// From a raw output of the series to the value and the verdict of one
// threshold. The series writes its manifest with this function and
// check-report.ts recomputes with it from the raw output, so a declared verdict
// that the raw output does not support is caught.
//
// Two outcomes are kept apart. `ok: false` is an incomplete measure (the raw
// output is missing, malformed, unavailable, or does not hold the protocol
// count): nothing was judged. `verdict: "fail"` is a measure that was made and
// is red. A measure can never pass for want of a sample.

import type { Interruption } from "./attempts";
import { INTERRUPTION_CAUSES, type MeasuredWith } from "./manifest";
import type { MeasureId, MeasureSpec } from "./protocol";
import { maximum, nearestRankP95, type Sample } from "./stats";

export const RAW_SCHEMA = "p04-series-raw.v1";

export type Verdict = "pass" | "fail";

export type Evaluation =
  | { ok: true; value: number; verdict: Verdict; examined: number }
  | { ok: false; issue: string };

export interface RoundTripPass {
  examined: number;
  identical: number;
  changed: number;
  missing: number;
  added: number;
}

export interface EditPass {
  expected: number;
  examined: number;
  conforming: number;
  unexpectedChanges: number;
}

export interface MemoryLaunch {
  peakMib: number;
  /** Readings taken (PROTOCOL.md section 10.4). */
  samples: number;
  /** Deadlines already passed when the previous reading ended, skipped. */
  missedTicks: number;
  medianReadingMs: number;
}

/**
 * Every raw output names the measure it belongs to and, for a measure made on
 * one note, that note: an output swapped between two entries of a manifest
 * (the two AT-02 configurations share a kind) is caught. It also lists the
 * passes, configurations or launches interrupted and redone, with their cause
 * (PROTOCOL.md sections 5 and 10.7), an empty list when there was none.
 */
interface Identity {
  schema: typeof RAW_SCHEMA;
  measure: MeasureId;
  note?: string;
  interruptions: Interruption[];
  /** The binary and instrument of every sample of the output (PROTOCOL.md section 10.7). */
  measuredWith: MeasuredWith;
}

export type RawBody =
  /**
   * PROTOCOL.md section 10.1. AT-02: `gapsMs[i]`, from the observation of the
   * change to the end bound of sample `i`. NFR-03: `callbacks[i]`, the
   * animation frame callbacks requested up to the end bound of launch `i`. Both
   * null where the sample is +oo.
   */
  | { kind: "latency"; unit: "ms"; samples: Sample[]; gapsMs: (number | null)[] }
  | { kind: "latency"; unit: "ms"; samples: Sample[]; callbacks: (number | null)[] }
  | { kind: "memory"; unit: "Mio"; launches: MemoryLaunch[] }
  | { kind: "round-trip"; passes: RoundTripPass[] }
  | { kind: "paragraph-edit"; editableFiles: number; passes: EditPass[] }
  | { kind: "accessibility"; role: string; total: number; matching: number }
  | { kind: "unavailable"; reason: string };

export type RawOutput = Identity & RawBody;

class Incomplete extends Error {}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Incomplete(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Incomplete(`${what} is not a non-negative integer`);
  }
  return value;
}

function list(value: unknown, what: string, length: number): unknown[] {
  if (!Array.isArray(value)) throw new Incomplete(`${what} is not a list`);
  if (value.length !== length) {
    throw new Incomplete(`${what} holds ${value.length} entries, the protocol requires ${length}`);
  }
  return value;
}

// One value per sample, null exactly where the sample is +oo; the others pass `valid`.
function alongside(
  raw: Record<string, unknown>,
  key: string,
  samples: readonly Sample[],
  valid: (value: number) => boolean,
): number[] {
  const values = list(raw[key], key, samples.length);
  const finite: number[] = [];
  values.forEach((value, index) => {
    if (value === null && samples[index] === null) return;
    if (typeof value !== "number" || !valid(value) || samples[index] === null) {
      throw new Incomplete(`${key} ${index} does not go with sample ${index}`);
    }
    finite.push(value);
  });
  return finite;
}

/**
 * The gaps between observation and end bound of AT-02 (PROTOCOL.md section
 * 10.1), one per keystroke, null exactly where the sample is +oo. The finite
 * gaps are returned: check-report.ts summarises them and compares the summary
 * of the manifest.
 */
export function gapsOf(raw: Record<string, unknown>, samples: readonly Sample[]): number[] {
  return alongside(raw, "gapsMs", samples, (gap) => Number.isFinite(gap) && gap >= 0);
}

/** The callbacks requested up to the end bound of each NFR-03 launch (section 10.1): at least one. */
function callbacksOf(raw: Record<string, unknown>, samples: readonly Sample[]): number[] {
  return alongside(
    raw,
    "callbacks",
    samples,
    (callbacks) => Number.isSafeInteger(callbacks) && callbacks >= 1,
  );
}

function latency(spec: MeasureSpec, raw: Record<string, unknown>): Evaluation {
  if (raw.unit !== "ms") throw new Incomplete("latency unit is not ms");
  const samples = list(raw.samples, "samples", spec.count).map((sample, index): Sample => {
    if (sample === null) return null;
    if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0) {
      throw new Incomplete(`sample ${index} is neither a non-negative number nor null (+oo)`);
    }
    return sample;
  });
  if (spec.id === "nfr-03") callbacksOf(raw, samples);
  else gapsOf(raw, samples);
  const value = nearestRankP95(samples);
  return {
    ok: true,
    value,
    verdict: value <= spec.limit ? "pass" : "fail",
    examined: samples.length,
  };
}

function memory(spec: MeasureSpec, raw: Record<string, unknown>): Evaluation {
  if (raw.unit !== "Mio") throw new Incomplete("memory unit is not Mio");
  const peaks = list(raw.launches, "launches", spec.count).map((entry, index) => {
    const launch = record(entry, `launch ${index}`);
    if (count(launch.samples, `readings of launch ${index}`) === 0) {
      throw new Incomplete(`launch ${index} has no reading`);
    }
    count(launch.missedTicks, `skipped deadlines of launch ${index}`);
    const median = launch.medianReadingMs;
    if (typeof median !== "number" || !Number.isFinite(median) || median < 0) {
      throw new Incomplete(`median reading time of launch ${index} is not recorded`);
    }
    const peak = launch.peakMib;
    if (typeof peak !== "number" || !Number.isFinite(peak) || peak <= 0) {
      throw new Incomplete(`peak of launch ${index} is not a positive number`);
    }
    return peak;
  });
  // A ceiling: compared to the maximum of the launch peaks (PROTOCOL.md section 10.4).
  const value = maximum(peaks);
  return {
    ok: true,
    value,
    verdict: value <= spec.limit ? "pass" : "fail",
    examined: peaks.length,
  };
}

function roundTrip(spec: MeasureSpec, raw: Record<string, unknown>): Evaluation {
  let examined = 0;
  let identical = 0;
  let clean = true;
  const passes = list(raw.passes, "passes", spec.count);
  passes.forEach((entry, index) => {
    const pass = record(entry, `pass ${index}`);
    const files = count(pass.examined, `files examined in pass ${index}`);
    const same = count(pass.identical, `identical files in pass ${index}`);
    const changed = count(pass.changed, `changed files in pass ${index}`);
    const missing = count(pass.missing, `missing files in pass ${index}`);
    const added = count(pass.added, `added files in pass ${index}`);
    // The oracle examines the reference snapshot: anything but the whole corpus is not a pass.
    if (files !== spec.limit) {
      throw new Incomplete(`pass ${index} examined ${files} files, the corpus holds ${spec.limit}`);
    }
    if (same + changed + missing !== files) {
      throw new Incomplete(`counts of pass ${index} do not add up to the files examined`);
    }
    examined += files;
    identical += same;
    if (same !== files || added !== 0) clean = false;
  });
  return {
    ok: true,
    value: (100 * identical) / examined,
    verdict: clean ? "pass" : "fail",
    examined: passes.length,
  };
}

function paragraphEdit(spec: MeasureSpec, raw: Record<string, unknown>): Evaluation {
  const editable = count(raw.editableFiles, "editable files");
  if (editable === 0) throw new Incomplete("the corpus counts no editable file");
  let expectedTotal = 0;
  let conformingTotal = 0;
  let clean = true;
  const passes = list(raw.passes, "passes", spec.count);
  passes.forEach((entry, index) => {
    const pass = record(entry, `pass ${index}`);
    const expected = count(pass.expected, `expected edits of pass ${index}`);
    const examined = count(pass.examined, `examined edits of pass ${index}`);
    const conforming = count(pass.conforming, `conforming edits of pass ${index}`);
    // A file that was not edited (not editable, or missing, or added) and whose bytes changed.
    const unexpected = count(pass.unexpectedChanges, `unexpected changes of pass ${index}`);
    if (expected !== editable) {
      throw new Incomplete(
        `pass ${index} expected ${expected} edits for ${editable} editable files`,
      );
    }
    if (examined > expected || conforming > examined) {
      throw new Incomplete(`counts of pass ${index} exceed what was expected`);
    }
    expectedTotal += expected;
    conformingTotal += conforming;
    // An expected edit not observed makes the line red (PROTOCOL.md section 10.5).
    if (examined !== expected || conforming !== examined || unexpected !== 0) clean = false;
  });
  return {
    ok: true,
    value: (100 * conformingTotal) / expectedTotal,
    verdict: clean ? "pass" : "fail",
    examined: passes.length,
  };
}

function accessibility(spec: MeasureSpec, raw: Record<string, unknown>): Evaluation {
  if (typeof raw.role !== "string") throw new Incomplete("accessibility role is not recorded");
  const total = count(raw.total, "reference UTF-16 units");
  const matching = count(raw.matching, "matching UTF-16 units");
  if (total === 0) throw new Incomplete("the reference text is empty");
  if (matching > total) throw new Incomplete("more matching units than reference units");
  const value = (100 * matching) / total;
  return { ok: true, value, verdict: value >= spec.limit ? "pass" : "fail", examined: 1 };
}

// The interruptions are recorded with a cause of the closed set of PROTOCOL.md
// section 10.7, never silently absent.
function interruptions(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Incomplete("interruptions are not recorded (a list, empty if none)");
  }
  value.forEach((entry, index) => {
    const { unit, attempt, cause, reason } = record(entry, `interruption ${index}`);
    if (typeof unit !== "string" || unit === "" || typeof reason !== "string" || reason === "") {
      throw new Incomplete(`interruption ${index} has no unit or no reason`);
    }
    if (!(INTERRUPTION_CAUSES as readonly unknown[]).includes(cause)) {
      throw new Incomplete(
        `interruption ${index}: cause ${String(cause)} is outside the closed set`,
      );
    }
    if (count(attempt, `attempt of interruption ${index}`) === 0) {
      throw new Incomplete(`interruption ${index}: attempts are counted from 1`);
    }
  });
}

export function evaluate(spec: MeasureSpec, input: unknown): Evaluation {
  try {
    const raw = record(input, "raw output");
    if (raw.schema !== RAW_SCHEMA) throw new Incomplete(`raw output schema is not ${RAW_SCHEMA}`);
    if (raw.kind === "unavailable") {
      const reason = typeof raw.reason === "string" ? raw.reason : "no reason given";
      throw new Incomplete(`measure unavailable: ${reason}`);
    }
    if (raw.kind !== spec.kind) {
      throw new Incomplete(`raw output is a ${String(raw.kind)}, the measure is a ${spec.kind}`);
    }
    if (raw.measure !== spec.id) {
      throw new Incomplete(`raw output belongs to ${String(raw.measure)}, the entry is ${spec.id}`);
    }
    if (spec.note !== null && raw.note !== spec.note) {
      throw new Incomplete(
        `raw output was made on ${String(raw.note)}, the measure is made on ${spec.note}`,
      );
    }
    interruptions(raw.interruptions);
    switch (spec.kind) {
      case "latency":
        return latency(spec, raw);
      case "memory":
        return memory(spec, raw);
      case "round-trip":
        return roundTrip(spec, raw);
      case "paragraph-edit":
        return paragraphEdit(spec, raw);
      case "accessibility":
        return accessibility(spec, raw);
    }
  } catch (error) {
    if (error instanceof Incomplete) return { ok: false, issue: error.message };
    throw error;
  }
}
