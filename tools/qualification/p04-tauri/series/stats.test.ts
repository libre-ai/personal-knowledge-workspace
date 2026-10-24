// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import { maximum, nearestRankP95 } from "./stats";

// Expected values are written from PROTOCOL.md section 4, not from the code:
// samples sorted ascending, p95 = sample of rank ceil(0.95 x N), counted from 1.
describe("nearest-rank p95 (PROTOCOL.md section 4)", () => {
  test("3 000 samples 1..3000 give the sample of rank 2 850", () => {
    const samples = Array.from({ length: 3000 }, (_, index) => 3000 - index);
    expect(nearestRankP95(samples)).toBe(2850);
  });

  test("60 samples 1..60 give the sample of rank 57", () => {
    const samples = Array.from({ length: 60 }, (_, index) => index + 1);
    expect(nearestRankP95(samples)).toBe(57);
  });

  test("no interpolation: 20 samples 10, 20, ... 200 give 190", () => {
    const samples = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
    expect(nearestRankP95(samples)).toBe(190);
  });

  test("a timed-out keystroke (+oo, written null) sorts last and stays in the sample", () => {
    const samples: (number | null)[] = Array.from({ length: 59 }, () => 1);
    samples.push(null);
    expect(nearestRankP95(samples)).toBe(1);
    const many: (number | null)[] = Array.from({ length: 57 }, () => 1);
    many.push(null, null, null, null);
    expect(nearestRankP95(many)).toBe(Number.POSITIVE_INFINITY);
  });

  test("an empty sample has no percentile", () => {
    expect(() => nearestRankP95([])).toThrow();
  });
});

describe("maximum (NFR-10 ceiling)", () => {
  test("is the largest value", () => {
    expect(maximum([3, 9, 4])).toBe(9);
  });

  test("an empty sample has no maximum", () => {
    expect(() => maximum([])).toThrow();
  });
});
