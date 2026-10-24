// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The manifest of a series report, `reports/ID/manifest.json` (CA-43, CA-48):
// the commit measured, the machine, the SHA-256 of the corpus, and one entry
// per threshold of PROTOCOL.md section 3 pointing at its raw output.

import type { Verdict } from "./evaluate";
import type { MeasureId } from "./protocol";

export const MANIFEST_SCHEMA = "p04-series-report.v1";

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

export interface MeasureEntry {
  id: MeasureId;
  measure: string;
  threshold: string;
  /** Path of the raw output, relative to the report directory. */
  raw: string;
  /** `null` stands for +oo (a p95 that falls on a timed-out keystroke). */
  value: number | null;
  verdict: Verdict;
}

export interface ReportManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** A trial run (fewer samples than the protocol, to tune the harness) is never a report. */
  trial: boolean;
  commit: string;
  createdAt: string;
  machine: MachineRecord;
  corpusSha256: string;
  /** Launches rejected and redone, by cause (PROTOCOL.md section 10.7). */
  rejectedLaunches: Record<string, number>;
  measures: MeasureEntry[];
}

/** JSON has no infinity: +oo is written `null`. */
export function toJsonValue(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function fromJsonValue(value: number | null): number {
  return value === null ? Number.POSITIVE_INFINITY : value;
}
