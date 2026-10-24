// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import { evaluate, RAW_SCHEMA } from "./evaluate";
import type { MeasureSpec } from "./protocol";

const latency: MeasureSpec = {
  id: "nfr-03",
  measure: "NFR-03",
  threshold: "p95 ≤ 100 ms",
  kind: "latency",
  count: 60,
  limit: 100,
};
const memory: MeasureSpec = {
  id: "nfr-10",
  measure: "NFR-10",
  threshold: "≤ 500 Mio",
  kind: "memory",
  count: 3,
  limit: 500,
};
const roundTrip: MeasureSpec = {
  id: "at-01-round-trip",
  measure: "AT-01, aller-retour",
  threshold: "100 %",
  kind: "round-trip",
  count: 2,
  limit: 10,
};
const edit: MeasureSpec = {
  id: "at-01-paragraph-edit",
  measure: "AT-01, édition",
  threshold: "aucun octet",
  kind: "paragraph-edit",
  count: 2,
  limit: 0,
};
const access: MeasureSpec = {
  id: "accessibility",
  measure: "Texte",
  threshold: "100 %",
  kind: "accessibility",
  count: 1,
  limit: 100,
};

const samples = (value: number | null, length: number) => Array.from({ length }, () => value);

describe("latency (p95 nearest rank against the limit, inclusive)", () => {
  test("p95 equal to the limit passes", () => {
    const result = evaluate(latency, {
      schema: RAW_SCHEMA,
      kind: "latency",
      unit: "ms",
      samples: samples(100, 60),
    });
    expect(result).toEqual({ ok: true, value: 100, verdict: "pass", examined: 60 });
  });

  test("p95 above the limit fails", () => {
    const values = [...samples(10, 56), ...samples(101, 4)];
    const result = evaluate(latency, {
      schema: RAW_SCHEMA,
      kind: "latency",
      unit: "ms",
      samples: values,
    });
    expect(result).toMatchObject({ ok: true, value: 101, verdict: "fail" });
  });

  test("timeouts at the rank make the p95 +oo and fail", () => {
    const values = [...samples(10, 56), ...samples(null, 4)];
    const result = evaluate(latency, {
      schema: RAW_SCHEMA,
      kind: "latency",
      unit: "ms",
      samples: values,
    });
    expect(result).toMatchObject({ ok: true, value: Number.POSITIVE_INFINITY, verdict: "fail" });
  });

  test("a sample count other than the protocol count is incomplete", () => {
    const result = evaluate(latency, {
      schema: RAW_SCHEMA,
      kind: "latency",
      unit: "ms",
      samples: samples(1, 59),
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("a negative latency is an instrument error, not a fast sample", () => {
    const result = evaluate(latency, {
      schema: RAW_SCHEMA,
      kind: "latency",
      unit: "ms",
      samples: [...samples(1, 59), -1],
    });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("memory (ceiling against the maximum of the launch peaks)", () => {
  const launches = (peaks: number[]) => peaks.map((peakMib) => ({ peakMib, samples: 50 }));

  test("a maximum at the ceiling passes", () => {
    const result = evaluate(memory, {
      schema: RAW_SCHEMA,
      kind: "memory",
      unit: "Mio",
      launches: launches([300, 500, 200]),
    });
    expect(result).toEqual({ ok: true, value: 500, verdict: "pass", examined: 3 });
  });

  test("one launch above the ceiling fails, whatever the p95", () => {
    const result = evaluate(memory, {
      schema: RAW_SCHEMA,
      kind: "memory",
      unit: "Mio",
      launches: launches([300, 501, 200]),
    });
    expect(result).toMatchObject({ ok: true, value: 501, verdict: "fail" });
  });

  test("among 60 launches, one above the ceiling fails although the p95 is under it", () => {
    const sixty = { ...memory, count: 60 };
    const peaks = [...Array.from({ length: 59 }, () => 300), 501];
    const result = evaluate(sixty, {
      schema: RAW_SCHEMA,
      kind: "memory",
      unit: "Mio",
      launches: launches(peaks),
    });
    expect(result).toMatchObject({ ok: true, value: 501, verdict: "fail" });
  });

  test("a launch without a reading is incomplete", () => {
    const result = evaluate(memory, {
      schema: RAW_SCHEMA,
      kind: "memory",
      unit: "Mio",
      launches: [...launches([1, 2]), { peakMib: 0, samples: 0 }],
    });
    expect(result).toMatchObject({ ok: false });
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

  test("every file identical on every pass passes", () => {
    const result = evaluate(roundTrip, {
      schema: RAW_SCHEMA,
      kind: "round-trip",
      passes: [pass(10), pass(10)],
    });
    expect(result).toEqual({ ok: true, value: 100, verdict: "pass", examined: 2 });
  });

  test("one changed file fails", () => {
    const result = evaluate(roundTrip, {
      schema: RAW_SCHEMA,
      kind: "round-trip",
      passes: [pass(10), pass(9, 1)],
    });
    expect(result).toMatchObject({ ok: true, verdict: "fail", value: 95 });
  });

  test("a pass that examined fewer files than the corpus is incomplete", () => {
    const short = { examined: 9, identical: 9, changed: 0, missing: 0, added: 0 };
    const result = evaluate(roundTrip, {
      schema: RAW_SCHEMA,
      kind: "round-trip",
      passes: [pass(10), short],
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("counts that do not add up are incomplete", () => {
    const wrong = { examined: 10, identical: 10, changed: 1, missing: 0, added: 0 };
    const result = evaluate(roundTrip, {
      schema: RAW_SCHEMA,
      kind: "round-trip",
      passes: [pass(10), wrong],
    });
    expect(result).toMatchObject({ ok: false });
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
    schema: RAW_SCHEMA,
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
      schema: RAW_SCHEMA,
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
  test("every UTF-16 unit matching passes", () => {
    const result = evaluate(access, {
      schema: RAW_SCHEMA,
      kind: "accessibility",
      role: "AXTextArea",
      total: 40,
      matching: 40,
    });
    expect(result).toEqual({ ok: true, value: 100, verdict: "pass", examined: 1 });
  });

  test("one unit missing fails", () => {
    const result = evaluate(access, {
      schema: RAW_SCHEMA,
      kind: "accessibility",
      role: "AXTextArea",
      total: 40,
      matching: 39,
    });
    expect(result).toMatchObject({ ok: true, verdict: "fail", value: 97.5 });
  });

  test("an empty reference is incomplete, never 0/0 passing", () => {
    const result = evaluate(access, {
      schema: RAW_SCHEMA,
      kind: "accessibility",
      role: "AXTextArea",
      total: 0,
      matching: 0,
    });
    expect(result).toMatchObject({ ok: false });
  });
});

describe("unavailable and malformed raw outputs", () => {
  test("an unavailable measure is incomplete, never a pass or a zero", () => {
    const result = evaluate(access, {
      schema: RAW_SCHEMA,
      kind: "unavailable",
      reason: "AXIsProcessTrusted() is false",
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("a raw output of another kind than its measure is incomplete", () => {
    const result = evaluate(latency, {
      schema: RAW_SCHEMA,
      kind: "accessibility",
      role: "x",
      total: 1,
      matching: 1,
    });
    expect(result).toMatchObject({ ok: false });
  });

  test("a raw output of another schema is incomplete", () => {
    const result = evaluate(latency, {
      schema: "other",
      kind: "latency",
      unit: "ms",
      samples: samples(1, 60),
    });
    expect(result).toMatchObject({ ok: false });
  });
});
