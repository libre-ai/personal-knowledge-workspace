// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import { type Clock, sampleOnDeadlines } from "./sampler";

// A clock that only moves when the sampler sleeps or a reading takes time.
function fakeClock(start: number): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
    async sleepUntil(instant: number) {
      if (instant > now) now = instant;
    },
  };
}

// PROTOCOL.md section 10.4: readings start at t0 + n x period, not at the end of
// the previous one; a deadline already passed when a reading ends is skipped and counted.
describe("NFR-10 readings on absolute deadlines", () => {
  test("readings shorter than the period start on every deadline", async () => {
    const clock = fakeClock(1000);
    const starts: number[] = [];
    const result = await sampleOnDeadlines({
      t0: 1000,
      periodMs: 100,
      clock,
      read: () => {
        starts.push(clock.now());
        clock.advance(30);
        return starts.length < 5;
      },
    });
    // The fifth call finds the process gone: it is not a reading.
    expect(starts).toEqual([1000, 1100, 1200, 1300, 1400]);
    expect(result).toEqual({ readings: 4, missedTicks: 0, medianReadingMs: 30 });
  });

  test("a reading longer than the period skips the deadline it overran, and counts it", async () => {
    const clock = fakeClock(0);
    const starts: number[] = [];
    const durations = [150, 30, 250, 30];
    const result = await sampleOnDeadlines({
      t0: 0,
      periodMs: 100,
      clock,
      read: () => {
        starts.push(clock.now());
        clock.advance(durations[starts.length - 1] ?? 0);
        return starts.length < durations.length;
      },
    });
    // 0 -> ends 150: 100 skipped, next 200 -> ends 230: next 300 -> ends 550: 400, 500 skipped.
    expect(starts).toEqual([0, 200, 300, 600]);
    expect(result.missedTicks).toBe(3);
    expect(result.readings).toBe(3);
  });

  test("a reading that ends exactly on a deadline does not skip it", async () => {
    const clock = fakeClock(0);
    const starts: number[] = [];
    const result = await sampleOnDeadlines({
      t0: 0,
      periodMs: 100,
      clock,
      read: () => {
        starts.push(clock.now());
        clock.advance(100);
        return starts.length < 3;
      },
    });
    expect(starts).toEqual([0, 100, 200]);
    expect(result).toMatchObject({ readings: 2, missedTicks: 0 });
  });

  test("the median reading time is the nearest-rank median of the durations", async () => {
    const clock = fakeClock(0);
    const durations = [10, 40, 20, 90];
    let index = 0;
    const result = await sampleOnDeadlines({
      t0: 0,
      periodMs: 100,
      clock,
      read: () => {
        clock.advance(durations[index] ?? 0);
        index += 1;
        return index < durations.length;
      },
    });
    // Three readings (the fourth call finds the process gone) of 10, 40 and 20 ms,
    // sorted 10, 20, 40: rank ceil(0.5 x 3) = 2.
    expect(result).toMatchObject({ readings: 3, medianReadingMs: 20 });
  });

  test("readings stop when the launch ends", async () => {
    const clock = fakeClock(0);
    let calls = 0;
    const result = await sampleOnDeadlines({
      t0: 0,
      periodMs: 100,
      clock,
      running: () => calls < 2,
      read: () => {
        calls += 1;
        return true;
      },
    });
    expect(result.readings).toBe(2);
  });
});
