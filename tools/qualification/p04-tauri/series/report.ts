// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// What run.ts writes: one raw output per measure, carrying its identity and its
// interruptions, and the manifest, which names the commit, the machine, the
// corpus, the protocol text and the binary measured, the launches rejected and
// the stop of the series.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Interruption } from "./attempts";
import { RAW_SCHEMA, type RawBody, type RawOutput } from "./evaluate";
import {
  type FramePeriod,
  MANIFEST_SCHEMA,
  type MachineRecord,
  type MeasuredWith,
  type MeasureEntry,
  type RejectionCause,
  type ReportManifest,
  type SeriesStop,
} from "./manifest";
import { FRAME_PERIOD_INTERVALS, type MeasureSpec } from "./protocol";

/**
 * The raw output of `spec`: its measure, its note (for a measure made on one
 * note), its interruptions, and the binary and instrument of its samples.
 */
export function rawOf(
  spec: MeasureSpec,
  body: RawBody,
  interruptions: readonly Interruption[],
  measuredWith: MeasuredWith,
): RawOutput {
  const note = spec.note === null ? {} : { note: spec.note };
  return {
    schema: RAW_SCHEMA,
    measure: spec.id,
    ...note,
    interruptions: [...interruptions],
    measuredWith: { ...measuredWith },
    ...body,
  };
}

/** The identity of a run (PROTOCOL.md section 10.7): the bytes of the binary, the harness commit, the script. */
export function measuredWithOf(
  binary: string,
  harnessCommit: string,
  scriptSha256: string,
): MeasuredWith {
  return { binarySha256: sha256File(binary), harnessCommit, scriptSha256 };
}

/**
 * The frame period the script reports at the start of a launch of AT-02 or
 * NFR-03 (PROTOCOL.md section 10.1). A report of another count of intervals,
 * or with a missing statistic, is an instrument error: the launch is redone.
 */
export function framePeriodOf(event: Record<string, unknown>): FramePeriod {
  const { intervals, p50Ms, p95Ms, maxMs } = event;
  const finite = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (intervals !== FRAME_PERIOD_INTERVALS) {
    throw new Error(
      `the frame period holds ${String(intervals)} intervals, the protocol reads ${FRAME_PERIOD_INTERVALS}`,
    );
  }
  if (!finite(p50Ms) || !finite(p95Ms) || !finite(maxMs)) {
    throw new Error("the launch reported an incomplete frame period");
  }
  return { intervals, p50Ms, p95Ms, maxMs };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface ManifestInput {
  trial: boolean;
  commit: string;
  machine: MachineRecord;
  corpusSha256: string;
  /** The bytes of PROTOCOL.md the series read its counts, thresholds and parameters from. */
  protocolBytes: Uint8Array;
  measuredWith: MeasuredWith;
  rejectedLaunches: Record<RejectionCause, number>;
  stopped: SeriesStop | null;
  measures: MeasureEntry[];
  createdAt: Date;
}

export function manifestOf(input: ManifestInput): ReportManifest {
  return {
    schema: MANIFEST_SCHEMA,
    trial: input.trial,
    commit: input.commit,
    createdAt: input.createdAt.toISOString(),
    machine: input.machine,
    corpusSha256: input.corpusSha256,
    protocolSha256: createHash("sha256").update(input.protocolBytes).digest("hex"),
    binarySha256: input.measuredWith.binarySha256,
    instrument: {
      harnessCommit: input.measuredWith.harnessCommit,
      scriptSha256: input.measuredWith.scriptSha256,
    },
    rejectedLaunches: input.rejectedLaunches,
    stopped: input.stopped,
    measures: input.measures,
  };
}
