// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The series reads its counts, thresholds and procedure parameters from
// PROTOCOL.md, never from constants of its own: a harness that restated them
// could drift from the frozen protocol without any test noticing.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { LARGE_NOTE_INDEX, LONG_NOTE_INDEX, notePath } from "../cr10k";
import { protocolFields, protocolThresholds } from "../protocol-fields";

export const PROTOCOL_RELATIVE_PATH = "tools/qualification/p04-tauri/PROTOCOL.md";

export function readProtocol(repositoryRoot: string): string {
  return readFileSync(join(repositoryRoot, PROTOCOL_RELATIVE_PATH), "utf8");
}

export interface SeriesParameters {
  readonly at01Passes: number;
  readonly at02Keystrokes: number;
  readonly nfr03Launches: number;
  readonly nfr10Launches: number;
  readonly corpusFiles: number;
  readonly corpusSha256: string;
  readonly machineClass: string;
  readonly keystrokeTimeoutMs: number;
  readonly memoryCeilingMib: number;
  readonly previewDelayMs: number;
  readonly at01EditText: string;
  readonly at02TypedCycle: string;
  readonly at02PauseMs: number;
  readonly nfr10SamplePeriodMs: number;
  readonly nfr10HoldMs: number;
  readonly saveTimeoutMs: number;
  readonly at01KeyGapMs: number;
  /** Section 10.3: the NFR-03 end state not observed this long after the start bound is +oo. */
  readonly nfr03EndTimeoutMs: number;
  /** Section 10.1: intervals of the frame period read at the start of an AT-02 or NFR-03 launch. */
  readonly framePeriodIntervals: number;
  /** Section 10.2: the page blocks its main thread this long in the start-bound control... */
  readonly timestampControlBlockMs: number;
  /** ...and the latency measured must be at least this. */
  readonly timestampControlMinLatencyMs: number;
  /** Section 10.6: UTF-16 units per AXStringForRange slice. */
  readonly axStringRangeChars: number;
  /** Section 10.7: rejections or interruptions of one cause in a row that stop the series. */
  readonly seriesStopConsecutive: number;
}

function field(fields: ReadonlyMap<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value === "") throw new Error(`PROTOCOL.md: field ${key} is missing`);
  return value;
}

function integer(fields: ReadonlyMap<string, string>, key: string): number {
  const text = field(fields, key);
  if (!/^[0-9]+$/.test(text)) throw new Error(`PROTOCOL.md: field ${key} is not an integer`);
  return Number(text);
}

function word(fields: ReadonlyMap<string, string>, key: string, pattern: RegExp): string {
  const text = field(fields, key);
  if (!pattern.test(text)) throw new Error(`PROTOCOL.md: field ${key} has an unexpected form`);
  return text;
}

export function seriesParameters(markdown: string): SeriesParameters {
  const fields = protocolFields(markdown);
  return {
    at01Passes: integer(fields, "at-01-passes"),
    at02Keystrokes: integer(fields, "at-02-keystrokes-per-configuration"),
    nfr03Launches: integer(fields, "nfr-03-launches"),
    nfr10Launches: integer(fields, "nfr-10-launches"),
    corpusFiles: integer(fields, "corpus-files"),
    corpusSha256: word(fields, "corpus-sha256", /^[0-9a-f]{64}$/),
    machineClass: word(fields, "machine-class", /^[a-z0-9-]+$/),
    keystrokeTimeoutMs: integer(fields, "keystroke-timeout-ms"),
    memoryCeilingMib: integer(fields, "memory-ceiling-mib"),
    previewDelayMs: integer(fields, "preview-delay-ms"),
    // Typed by system keystrokes, one key per character: lowercase ASCII and digits only.
    at01EditText: word(fields, "at-01-edit-text", /^[a-z0-9]+$/),
    at02TypedCycle: word(fields, "at-02-typed-cycle", /^[a-z0-9]+$/),
    at02PauseMs: integer(fields, "at-02-pause-ms"),
    nfr10SamplePeriodMs: integer(fields, "nfr-10-sample-period-ms"),
    nfr10HoldMs: integer(fields, "nfr-10-hold-ms"),
    saveTimeoutMs: integer(fields, "save-timeout-ms"),
    at01KeyGapMs: integer(fields, "at-01-key-gap-ms"),
    nfr03EndTimeoutMs: integer(fields, "nfr-03-end-timeout-ms"),
    framePeriodIntervals: integer(fields, "frame-period-intervals"),
    timestampControlBlockMs: integer(fields, "timestamp-control-block-ms"),
    timestampControlMinLatencyMs: integer(fields, "timestamp-control-min-latency-ms"),
    axStringRangeChars: integer(fields, "ax-string-range-chars"),
    seriesStopConsecutive: integer(fields, "series-stop-consecutive"),
  };
}

export type MeasureKind = "round-trip" | "paragraph-edit" | "latency" | "memory" | "accessibility";

export type MeasureId =
  | "at-01-round-trip"
  | "at-01-paragraph-edit"
  | "at-02-5000-lines"
  | "at-02-1-mib"
  | "nfr-03"
  | "nfr-10"
  | "accessibility";

export interface MeasureSpec {
  readonly id: MeasureId;
  /** The words of the "Mesure" cell of PROTOCOL.md section 3: the key of a manifest entry. */
  readonly measure: string;
  readonly threshold: string;
  readonly kind: MeasureKind;
  /** Passes (AT-01), keystrokes (AT-02) or launches (NFR-03, NFR-10); 1 for accessibility. */
  readonly count: number;
  /** ms for a latency, Mio for memory, % for a share; the number of corpus files for AT-01. */
  readonly limit: number;
  /** The corpus note the measure is made on (PROTOCOL.md section 10); null for AT-01, made on every file. */
  readonly note: string | null;
  /** The launches that read a frame period at their start (section 10.1): 1 per AT-02 configuration, 1 per NFR-03 sample, 0 elsewhere. */
  readonly framedLaunches: number;
}

function limitOf(threshold: string, pattern: RegExp, measure: string): number {
  const value = pattern.exec(threshold)?.[1];
  if (value === undefined)
    throw new Error(`PROTOCOL.md: threshold of ${measure} has an unexpected form`);
  return Number(value);
}

// Every row of the threshold table must be classified; a row this function does
// not know is a protocol the harness does not implement, and it is refused.
export function measureSpecs(markdown: string): MeasureSpec[] {
  const parameters = seriesParameters(markdown);
  const specs: MeasureSpec[] = [];
  for (const { measure, threshold } of protocolThresholds(markdown)) {
    const latency = /^p95 ≤ ([0-9]+) ms$/;
    let spec: Omit<MeasureSpec, "measure" | "threshold" | "note" | "framedLaunches">;
    if (measure.startsWith("AT-01, aller-retour")) {
      if (!threshold.startsWith("100 % des 10 000 fichiers"))
        throw new Error(`PROTOCOL.md: threshold of ${measure} has an unexpected form`);
      spec = {
        id: "at-01-round-trip",
        kind: "round-trip",
        count: parameters.at01Passes,
        limit: parameters.corpusFiles,
      };
    } else if (measure.startsWith("AT-01, édition")) {
      if (threshold !== "aucun octet modifié hors du paragraphe")
        throw new Error(`PROTOCOL.md: threshold of ${measure} has an unexpected form`);
      spec = {
        id: "at-01-paragraph-edit",
        kind: "paragraph-edit",
        count: parameters.at01Passes,
        limit: 0,
      };
    } else if (measure.startsWith("AT-02") && measure.endsWith("5 000 lignes")) {
      spec = {
        id: "at-02-5000-lines",
        kind: "latency",
        count: parameters.at02Keystrokes,
        limit: limitOf(threshold, latency, measure),
      };
    } else if (measure.startsWith("AT-02") && measure.endsWith("1 Mio")) {
      spec = {
        id: "at-02-1-mib",
        kind: "latency",
        count: parameters.at02Keystrokes,
        limit: limitOf(threshold, latency, measure),
      };
    } else if (measure.startsWith("NFR-03")) {
      spec = {
        id: "nfr-03",
        kind: "latency",
        count: parameters.nfr03Launches,
        limit: limitOf(threshold, latency, measure),
      };
    } else if (measure.startsWith("NFR-10")) {
      const limit = limitOf(threshold, /^≤ ([0-9]+) Mio/, measure);
      if (limit !== parameters.memoryCeilingMib)
        throw new Error("PROTOCOL.md: the NFR-10 threshold differs from memory-ceiling-mib");
      spec = { id: "nfr-10", kind: "memory", count: parameters.nfr10Launches, limit };
    } else if (measure.startsWith("Texte d'une note")) {
      spec = {
        id: "accessibility",
        kind: "accessibility",
        count: 1,
        limit: limitOf(threshold, /^([0-9]+) %$/, measure),
      };
    } else {
      throw new Error(`PROTOCOL.md: no series procedure for the threshold row "${measure}"`);
    }
    if (specs.some((known) => known.id === spec.id))
      throw new Error(`PROTOCOL.md: two threshold rows map to ${spec.id}`);
    const note =
      spec.kind === "round-trip" || spec.kind === "paragraph-edit"
        ? null
        : notePath(spec.id === "at-02-5000-lines" ? LONG_NOTE_INDEX : LARGE_NOTE_INDEX);
    // Section 10.1: the frame period is read at the start of each launch of AT-02
    // (one per configuration) and of NFR-03 (one per sample), and of no other.
    const framedLaunches = spec.id.startsWith("at-02") ? 1 : spec.id === "nfr-03" ? spec.count : 0;
    specs.push({ ...spec, measure, threshold, note, framedLaunches });
  }
  return specs;
}
