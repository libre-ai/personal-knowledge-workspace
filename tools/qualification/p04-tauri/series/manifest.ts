// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The manifest of a series report, `reports/ID/manifest.json` (CA-43, CA-48):
// the commit measured, the machine, the SHA-256 of the corpus, of the protocol
// text and of the binary measured, the launches rejected, the stop of the
// series if any, and one entry per threshold of PROTOCOL.md section 3 pointing
// at its raw output.

import type { Verdict } from "./evaluate";
import type { MeasureId } from "./protocol";

export const MANIFEST_SCHEMA = "p04-series-report.v1";

/** The closed set of causes of a rejected launch (PROTOCOL.md section 10.7). */
export const REJECTION_CAUSES = [
  "session-locked",
  "display-asleep",
  "helpers-unattributed",
] as const;
export type RejectionCause = (typeof REJECTION_CAUSES)[number];

/** The closed set of causes of an interrupted pass, configuration or launch (PROTOCOL.md section 10.7). */
export const INTERRUPTION_CAUSES = [
  "page-hidden",
  "shell-exited",
  "shell-not-frontmost",
  "instrument-error",
] as const;
export type InterruptionCause = (typeof INTERRUPTION_CAUSES)[number];

/** Three rejections or interruptions in a row of one of these causes stop the series. */
export type StopCause = RejectionCause | InterruptionCause;
export const STOP_CAUSES: readonly StopCause[] = [...REJECTION_CAUSES, ...INTERRUPTION_CAUSES];

/**
 * Whose defect a stop is (PROTOCOL.md section 10.7): `shell-exited` is a defect
 * of the product measured, not of the machine; an instrument error is the
 * harness's; the other causes are states of the machine (a locked session, a
 * screen off, another application in front or using WebKit, a hidden window).
 */
export type Defect = "product" | "instrument" | "machine";
export function defectOf(cause: StopCause): Defect {
  if (cause === "shell-exited") return "product";
  if (cause === "instrument-error") return "instrument";
  return "machine";
}

export interface MachineRecord {
  class: string;
  operatingSystem: string;
  architecture: string;
  hardwareModel: string;
  processor: string;
  memoryBytes: number;
  logicalCpu: number;
  hypervisorPresent: boolean;
  osVersion: string;
}

/**
 * The frame period of one launch of AT-02 or NFR-03 (PROTOCOL.md section 10.1),
 * read at its start: the intervals between successive `requestAnimationFrame`
 * callbacks, their count, nearest-rank p50 and p95, and maximum, in ms.
 */
export interface FramePeriod {
  intervals: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * The gap between the observation of the change and the end bound (PROTOCOL.md
 * section 10.1), per configuration of AT-02: count of the samples observed,
 * nearest-rank p50 and p95, and maximum, in ms.
 */
export interface GapSummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface MeasureEntry {
  id: MeasureId;
  measure: string;
  threshold: string;
  /** Path of the raw output, relative to the report directory. */
  raw: string;
  /** `null` stands for +oo (a p95 that falls on a timed-out keystroke). */
  value: number | null;
  verdict: Verdict;
  /** One frame period per launch of AT-02 and NFR-03 (`MeasureSpec.framedLaunches`), none elsewhere. */
  framePeriods: FramePeriod[];
  /** For AT-02, recomputed by check-report.ts from the gaps of the raw output; null elsewhere. */
  boundGap: GapSummary | null;
}

export interface SeriesStop {
  cause: StopCause;
  /** `defectOf(cause)`. */
  defect: Defect;
  /** The pass, configuration or launch where the third rejection or interruption happened. */
  unit: string;
}

/**
 * What a sample was measured with (PROTOCOL.md section 10.7): the binary, the
 * commit of the harness and the SHA-256 of the instrumentation script. A series
 * resumed after a corrected instrument or product starts again from zero, so
 * every raw output of a report carries the one identity of its manifest.
 */
export interface MeasuredWith {
  binarySha256: string;
  harnessCommit: string;
  scriptSha256: string;
}

export interface ReportManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** A trial run (fewer samples than the protocol, to tune the harness) is never a report. */
  trial: boolean;
  commit: string;
  createdAt: string;
  machine: MachineRecord;
  corpusSha256: string;
  /** SHA-256 of the bytes of PROTOCOL.md read at measurement time (PROTOCOL.md section 10.8). */
  protocolSha256: string;
  /** SHA-256 of the series binary that was measured. */
  binarySha256: string;
  /** The instrument: commit of the harness and SHA-256 of the instrumentation script. */
  instrument: { harnessCommit: string; scriptSha256: string };
  /** Launches rejected and redone, by cause (PROTOCOL.md section 10.7): exactly the causes below. */
  rejectedLaunches: Record<RejectionCause, number>;
  /** The series stopped by three rejections or interruptions of one cause in a row, or null. */
  stopped: SeriesStop | null;
  measures: MeasureEntry[];
}

/** JSON has no infinity: +oo is written `null`. */
export function toJsonValue(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function fromJsonValue(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}
