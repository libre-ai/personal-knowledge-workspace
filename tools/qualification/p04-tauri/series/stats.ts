// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Statistics of PROTOCOL.md section 4. A keystroke whose painting is not
// observed within the timeout is +oo (section 5); in JSON it is written `null`,
// which JSON cannot spell as infinity. Both the series and check-report.ts use
// these two functions, so a report is judged by the arithmetic that wrote it
// and check-report.ts recomputes rather than trusts the declared value.

export type Sample = number | null;

function finiteOrInfinite(sample: Sample): number {
  return sample === null ? Number.POSITIVE_INFINITY : sample;
}

// Nearest rank on the pooled samples: sorted ascending, the sample of rank
// ceil(0.95 x N), counted from 1. No interpolation.
export function nearestRankP95(samples: readonly Sample[]): number {
  if (samples.length === 0) throw new Error("p95 of an empty sample");
  const sorted = samples.map(finiteOrInfinite).sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  const value = sorted[rank - 1];
  if (value === undefined) throw new Error("p95 rank outside the sample");
  return value;
}

/**
 * Count, nearest-rank p50 and p95 and maximum of finite values (sections 4 and
 * 10.1): the summary of the gaps between the observation of a change and its
 * end bound. Null for no value: an empty summary is not a summary of zeros.
 */
export function summary(
  values: readonly number[],
): { count: number; p50Ms: number; p95Ms: number; maxMs: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number): number => {
    const value = sorted[Math.ceil(q * sorted.length) - 1];
    if (value === undefined) throw new Error("rank outside the sample");
    return value;
  };
  return { count: sorted.length, p50Ms: rank(0.5), p95Ms: rank(0.95), maxMs: rank(1) };
}

export function maximum(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("maximum of an empty sample");
  return samples.reduce((largest, sample) => (sample > largest ? sample : largest));
}
