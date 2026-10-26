// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import { evaluate, RAW_SCHEMA } from "./evaluate";
import type { MeasureSpec } from "./protocol";

const LARGE = "notes/00/note-00000.md";

const latency: MeasureSpec = {
  id: "nfr-03",
  measure: "NFR-03",
  threshold: "p95 ≤ 100 ms",
  kind: "latency",
  count: 60,
  limit: 100,
  note: LARGE,
  framedLaunches: 60,
};
const memory: MeasureSpec = {
  id: "nfr-10",
  measure: "NFR-10",
  threshold: "≤ 500 Mio",
  kind: "memory",
  count: 3,
  limit: 500,
  note: LARGE,
  framedLaunches: 0,
};
const roundTrip: MeasureSpec = {
  id: "at-01-round-trip",
  measure: "AT-01, aller-retour",
  threshold: "100 %",
  kind: "round-trip",
  count: 2,
  limit: 10,
  note: null,
  framedLaunches: 0,
};
const edit: MeasureSpec = {
  id: "at-01-paragraph-edit",
  measure: "AT-01, édition",
  threshold: "aucun octet",
  kind: "paragraph-edit",
  count: 2,
  limit: 0,
  note: null,
  framedLaunches: 0,
};
const access: MeasureSpec = {
  id: "accessibility",
  measure: "Texte",
  threshold: "100 %",
  kind: "accessibility",
  count: 1,
  limit: 100,
  note: LARGE,
  framedLaunches: 0,
};

// The identity every raw output carries: the measure it belongs to and, for a
// measure made on one note, that note; and its interruptions, none here.
const of = (spec: MeasureSpec) =>
  spec.note === null
    ? { schema: RAW_SCHEMA, measure: spec.id, interruptions: [] }
    : { schema: RAW_SCHEMA, measure: spec.id, note: spec.note, interruptions: [] };

const samples = (value: number | null, length: number) => Array.from({ length }, () => value);
// NFR-03: one callback up to the bound beside every finite sample, none beside a +oo.
const latencyRaw = (values: (number | null)[]) => ({
  ...of(latency),
  kind: "latency",
  unit: "ms",
  samples: values,
  callbacks: values.map((value) => (value === null ? null : 1)),
});

const keystrokes: MeasureSpec = {
  id: "at-02-5000-lines",
  measure: "AT-02, 5 000 lignes",
  threshold: "p95 ≤ 16 ms",
  kind: "latency",
  count: 4,
  limit: 16,
  note: "notes/01/note-00001.md",
  framedLaunches: 1,
};
// AT-02: a gap of 1 ms from observation to bound beside every finite sample.
const keystrokeRaw = (values: (number | null)[]) => ({
  ...of(keystrokes),
  kind: "latency",
  unit: "ms",
  samples: values,
  gapsMs: values.map((value) => (value === null ? null : 1)),
});

describe("latency (p95 nearest rank against the limit, inclusive)", () => {
  test("p95 equal to the limit passes", () => {
    expect(evaluate(latency, latencyRaw(samples(100, 60)))).toEqual({
      ok: true,
      value: 100,
      verdict: "pass",
      examined: 60,
    });
  });

  test("p95 above the limit fails", () => {
    const result = evaluate(latency, latencyRaw([...samples(10, 56), ...samples(101, 4)]));
    expect(result).toMatchObject({ ok: true, value: 101, verdict: "fail" });
  });

  test("timeouts at the rank make the p95 +oo and fail", () => {
    const result = evaluate(latency, latencyRaw([...samples(10, 56), ...samples(null, 4)]));
    expect(result).toMatchObject({ ok: true, value: Number.POSITIVE_INFINITY, verdict: "fail" });
  });

  test("a sample count other than the protocol count is incomplete", () => {
    expect(evaluate(latency, latencyRaw(samples(1, 59)))).toMatchObject({ ok: false });
  });

  test("a negative latency is an instrument error, not a fast sample", () => {
    expect(evaluate(latency, latencyRaw([...samples(1, 59), -1]))).toMatchObject({ ok: false });
  });
});

describe("memory (ceiling against the maximum of the launch peaks)", () => {
  const launches = (peaks: number[]) =>
    peaks.map((peakMib) => ({ peakMib, samples: 50, missedTicks: 0, medianReadingMs: 12 }));
  const raw = (spec: MeasureSpec, entries: unknown[]) => ({
    ...of(spec),
    kind: "memory",
    unit: "Mio",
    launches: entries,
  });

  test("a maximum at the ceiling passes", () => {
    expect(evaluate(memory, raw(memory, launches([300, 500, 200])))).toEqual({
      ok: true,
      value: 500,
      verdict: "pass",
      examined: 3,
    });
  });

  test("one launch above the ceiling fails, whatever the p95", () => {
    const result = evaluate(memory, raw(memory, launches([300, 501, 200])));
    expect(result).toMatchObject({ ok: true, value: 501, verdict: "fail" });
  });

  test("among 60 launches, one above the ceiling fails although the p95 is under it", () => {
    const sixty = { ...memory, count: 60 };
    const peaks = [...Array.from({ length: 59 }, () => 300), 501];
    const result = evaluate(sixty, raw(sixty, launches(peaks)));
    expect(result).toMatchObject({ ok: true, value: 501, verdict: "fail" });
  });

  test("a launch without a reading is incomplete", () => {
    const entries = [
      ...launches([1, 2]),
      { peakMib: 0, samples: 0, missedTicks: 0, medianReadingMs: 0 },
    ];
    expect(evaluate(memory, raw(memory, entries))).toMatchObject({ ok: false });
  });

  // PROTOCOL.md section 10.4: readings, skipped deadlines and median reading time are recorded.
  test("a launch without its skipped deadlines or its median reading time is incomplete", () => {
    const [first, second] = launches([1, 2]);
    expect(
      evaluate(
        memory,
        raw(memory, [first, second, { peakMib: 3, samples: 5, medianReadingMs: 9 }]),
      ),
    ).toMatchObject({
      ok: false,
    });
    expect(
      evaluate(memory, raw(memory, [first, second, { peakMib: 3, samples: 5, missedTicks: 0 }])),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("AT-01 round trip", () => {
  const pass = (identical: number, changed = 0) => ({
    examined: 10,
    identical,
    changed,
    missing: 0,
    added: 0,
  });
  const raw = (passes: unknown[]) => ({ ...of(roundTrip), kind: "round-trip", passes });

  test("every file identical on every pass passes", () => {
    expect(evaluate(roundTrip, raw([pass(10), pass(10)]))).toEqual({
      ok: true,
      value: 100,
      verdict: "pass",
      examined: 2,
    });
  });

  test("one changed file fails", () => {
    expect(evaluate(roundTrip, raw([pass(10), pass(9, 1)]))).toMatchObject({
      ok: true,
      verdict: "fail",
      value: 95,
    });
  });

  test("a pass that examined fewer files than the corpus is incomplete", () => {
    const short = { examined: 9, identical: 9, changed: 0, missing: 0, added: 0 };
    expect(evaluate(roundTrip, raw([pass(10), short]))).toMatchObject({ ok: false });
  });

  test("counts that do not add up are incomplete", () => {
    const wrong = { examined: 10, identical: 10, changed: 1, missing: 0, added: 0 };
    expect(evaluate(roundTrip, raw([pass(10), wrong]))).toMatchObject({ ok: false });
  });
});

describe("AT-01 paragraph edit", () => {
  const raw = (
    passes: {
      expected: number;
      examined: number;
      conforming: number;
      unexpectedChanges?: number;
    }[],
  ) => ({
    ...of(edit),
    kind: "paragraph-edit",
    editableFiles: 8,
    passes: passes.map((pass) => ({ unexpectedChanges: 0, ...pass })),
  });

  test("a file outside the edited set that changed fails", () => {
    const result = evaluate(
      edit,
      raw([
        { expected: 8, examined: 8, conforming: 8, unexpectedChanges: 1 },
        { expected: 8, examined: 8, conforming: 8 },
      ]),
    );
    expect(result).toMatchObject({ ok: true, verdict: "fail" });
  });

  test("a pass without its count of unexpected changes is incomplete", () => {
    const result = evaluate(edit, {
      ...of(edit),
      kind: "paragraph-edit",
      editableFiles: 8,
      passes: [
        { expected: 8, examined: 8, conforming: 8 },
        { expected: 8, examined: 8, conforming: 8 },
      ],
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("every expected edit examined and conforming passes", () => {
    const result = evaluate(
      edit,
      raw([
        { expected: 8, examined: 8, conforming: 8 },
        { expected: 8, examined: 8, conforming: 8 },
      ]),
    );
    expect(result).toEqual({ ok: true, value: 100, verdict: "pass", examined: 2 });
  });

  test("a byte changed outside the paragraph fails", () => {
    const result = evaluate(
      edit,
      raw([
        { expected: 8, examined: 8, conforming: 7 },
        { expected: 8, examined: 8, conforming: 8 },
      ]),
    );
    expect(result).toMatchObject({ ok: true, verdict: "fail" });
  });

  test("an expected edit not observed fails: the line cannot pass for want of an edit", () => {
    const result = evaluate(
      edit,
      raw([
        { expected: 8, examined: 7, conforming: 7 },
        { expected: 8, examined: 8, conforming: 8 },
      ]),
    );
    expect(result).toMatchObject({ ok: true, verdict: "fail" });
  });

  test("a pass expecting another number of edits than the editable files is incomplete", () => {
    const result = evaluate(
      edit,
      raw([
        { expected: 7, examined: 7, conforming: 7 },
        { expected: 8, examined: 8, conforming: 8 },
      ]),
    );
    expect(result).toMatchObject({ ok: false });
  });
});

describe("accessibility", () => {
  // The copy found; reading (1) gives the measure, (2) and (3) read less.
  const readings = (first: number, second = 0, third = 0) => [
    { reading: 1, length: 40, matching: first },
    { reading: 2, length: 40, matching: second },
    { reading: 3, length: 0, matching: third },
  ];
  const raw = (total: number, matching: number) => ({
    ...of(access),
    kind: "accessibility",
    total,
    matching,
    found: true,
    visited: 7,
    chosen: 1,
    element: { role: "AXGroup", subrole: null, readings: readings(matching) },
    focused: null,
  });

  // PROTOCOL.md section 10.6: the highest of the three proportions, the first in
  // order at equality; a copy not found is 0, recorded with the elements walked.
  test("a measure that is not the highest reading is incomplete", () => {
    const lower = {
      ...raw(40, 30),
      element: { role: "AXGroup", subrole: null, readings: readings(30, 40) },
    };
    expect(evaluate(access, lower)).toMatchObject({ ok: false });
  });

  test("at equality the first reading in order is the one recorded", () => {
    const tie = {
      ...raw(40, 40),
      element: { role: "AXGroup", subrole: null, readings: readings(40, 40) },
    };
    expect(evaluate(access, tie)).toMatchObject({ ok: true, verdict: "pass" });
    expect(evaluate(access, { ...tie, chosen: 2 })).toMatchObject({ ok: false });
  });

  test("the measure from (3) when (1) and (2) read a prefixed text", () => {
    const third = {
      ...raw(40, 40),
      chosen: 3,
      element: { role: "AXGroup", subrole: "AXDocument", readings: readings(0, 0, 40) },
    };
    expect(evaluate(access, third)).toMatchObject({ ok: true, value: 100, verdict: "pass" });
  });

  test("a copy not found is a measure of 0, red, never unavailable", () => {
    const notFound = { ...raw(40, 0), found: false, chosen: null, element: null };
    expect(evaluate(access, notFound)).toMatchObject({ ok: true, value: 0, verdict: "fail" });
    expect(evaluate(access, { ...notFound, matching: 5 })).toMatchObject({ ok: false });
  });

  test("without found, visited, roles or the three readings in order, incomplete", () => {
    const { found: _found, ...noFound } = raw(40, 40);
    expect(evaluate(access, noFound)).toMatchObject({ ok: false });
    const { visited: _visited, ...noVisited } = raw(40, 40);
    expect(evaluate(access, noVisited)).toMatchObject({ ok: false });
    expect(
      evaluate(access, { ...raw(40, 40), element: { role: "AXGroup", readings: readings(40) } }),
    ).toMatchObject({ ok: false });
    const swapped = [...readings(40)].reverse();
    expect(
      evaluate(access, {
        ...raw(40, 40),
        element: { role: "AXGroup", subrole: null, readings: swapped },
      }),
    ).toMatchObject({ ok: false });
  });

  test("every UTF-16 unit matching passes", () => {
    expect(evaluate(access, raw(40, 40))).toEqual({
      ok: true,
      value: 100,
      verdict: "pass",
      examined: 1,
    });
  });

  test("one unit missing fails", () => {
    expect(evaluate(access, raw(40, 39))).toMatchObject({ ok: true, verdict: "fail", value: 97.5 });
  });

  test("an empty reference is incomplete, never 0/0 passing", () => {
    expect(evaluate(access, raw(0, 0))).toMatchObject({ ok: false });
  });
});

describe("identity of a raw output (the measure and the note it was made on)", () => {
  test("a raw output of another measure is incomplete, even of the same kind", () => {
    const swapped = { ...latencyRaw(samples(1, 60)), measure: "at-02-1-mib" };
    expect(evaluate(latency, swapped)).toMatchObject({ ok: false });
  });

  test("a raw output made on another note is incomplete", () => {
    const other = { ...latencyRaw(samples(1, 60)), note: "notes/01/note-00001.md" };
    expect(evaluate(latency, other)).toMatchObject({ ok: false });
  });

  test("a raw output without its identity is incomplete", () => {
    const { measure: _measure, ...anonymous } = latencyRaw(samples(1, 60));
    expect(evaluate(latency, anonymous)).toMatchObject({ ok: false });
  });
});

// PROTOCOL.md sections 5 and 10.7: interrupted passes, configurations and launches
// are recorded with a cause of the closed set; the list is part of every raw output.
describe("interruptions recorded by a raw output", () => {
  const green = latencyRaw(samples(1, 60));

  test("recorded interruptions do not change the verdict", () => {
    const interrupted = {
      ...green,
      interruptions: [
        { unit: "nfr-03 launch 4", attempt: 1, cause: "page-hidden", reason: "hidden" },
      ],
    };
    expect(evaluate(latency, interrupted)).toMatchObject({ ok: true, verdict: "pass" });
  });

  test("a raw output without its list of interruptions is incomplete", () => {
    const { interruptions: _interruptions, ...silent } = green;
    const result = evaluate(latency, silent);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.issue).toContain("interruptions");
  });

  test("an interruption outside the closed set, or without unit, reason or attempt from 1, is incomplete", () => {
    const valid = { unit: "nfr-03 launch 4", attempt: 1, cause: "instrument-error", reason: "x" };
    for (const entry of [
      { ...valid, cause: "window-hidden" },
      { ...valid, unit: "" },
      { ...valid, reason: "" },
      { ...valid, attempt: 0 },
      { ...valid, attempt: 1.5 },
    ]) {
      expect(evaluate(latency, { ...green, interruptions: [entry] })).toMatchObject({ ok: false });
    }
  });
});

// PROTOCOL.md section 10.1: per AT-02 keystroke, the gap from the observation of
// the change to the end bound; per NFR-03 launch, the callbacks up to the bound.
describe("AT-02: gaps between observation and end bound", () => {
  test("gaps beside every finite sample, none beside a +oo: complete", () => {
    expect(evaluate(keystrokes, keystrokeRaw([1, 2, null, 3]))).toMatchObject({ ok: true });
  });

  test("a keystroke latency without its gaps is incomplete", () => {
    const { gapsMs: _gaps, ...silent } = keystrokeRaw(samples(1, 4));
    expect(evaluate(keystrokes, silent)).toMatchObject({ ok: false });
  });

  test("a gap beside a +oo sample, or none beside a finite one, is incomplete", () => {
    expect(
      evaluate(keystrokes, { ...keystrokeRaw([1, 1, 1, null]), gapsMs: [1, 1, 1, 1] }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      evaluate(keystrokes, { ...keystrokeRaw(samples(1, 4)), gapsMs: [1, 1, 1, null] }),
    ).toMatchObject({
      ok: false,
    });
  });

  test("a negative gap, or a list of another length, is incomplete", () => {
    expect(
      evaluate(keystrokes, { ...keystrokeRaw(samples(1, 4)), gapsMs: [1, 1, 1, -1] }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      evaluate(keystrokes, { ...keystrokeRaw(samples(1, 4)), gapsMs: [1, 1, 1] }),
    ).toMatchObject({
      ok: false,
    });
  });
});

describe("NFR-03: callbacks up to the end bound", () => {
  test("a launch latency without its callbacks is incomplete", () => {
    const { callbacks: _callbacks, ...silent } = latencyRaw(samples(1, 60));
    expect(evaluate(latency, silent)).toMatchObject({ ok: false });
  });

  test("zero callbacks beside a finite sample, or a count beside a +oo, is incomplete", () => {
    expect(
      evaluate(latency, { ...latencyRaw(samples(1, 60)), callbacks: [...samples(1, 59), 0] }),
    ).toMatchObject({ ok: false });
    expect(
      evaluate(latency, { ...latencyRaw([...samples(1, 59), null]), callbacks: samples(1, 60) }),
    ).toMatchObject({ ok: false });
  });
});

describe("unavailable and malformed raw outputs", () => {
  test("an unavailable measure is incomplete, never a pass or a zero", () => {
    const result = evaluate(access, {
      ...of(access),
      kind: "unavailable",
      reason: "AXIsProcessTrusted() is false",
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("a raw output of another kind than its measure is incomplete", () => {
    const result = evaluate(latency, {
      ...of(latency),
      kind: "accessibility",
      total: 1,
      matching: 1,
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("a raw output of another schema is incomplete", () => {
    expect(evaluate(latency, { ...latencyRaw(samples(1, 60)), schema: "other" })).toMatchObject({
      ok: false,
    });
  });
});
