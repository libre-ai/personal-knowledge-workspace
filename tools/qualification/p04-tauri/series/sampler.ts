// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// NFR-10 readings on absolute deadlines (PROTOCOL.md section 10.4): readings
// start at t0 + n x period, t0 being the creation of the process, until it
// exits; a reading starts at its deadline, not at the end of the previous one.
// A deadline already passed when the previous reading ends is skipped and
// counted. The report records, per launch, the readings, the skipped deadlines
// and the median duration of a reading.

export interface Clock {
  now(): number;
  sleepUntil(instant: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleepUntil: async (instant) => {
    const wait = instant - performance.now();
    if (wait > 0) await Bun.sleep(wait);
  },
};

export interface Sampling {
  readings: number;
  missedTicks: number;
  medianReadingMs: number;
}

export async function sampleOnDeadlines(options: {
  t0: number;
  periodMs: number;
  clock: Clock;
  /** One reading; false when the process has exited: nothing was read, the readings stop. */
  read: () => boolean;
  /** Checked at each deadline: false stops the readings. */
  running?: () => boolean;
}): Promise<Sampling> {
  const { t0, periodMs, clock, read } = options;
  const running = options.running ?? (() => true);
  const durations: number[] = [];
  let missedTicks = 0;
  let deadline = 0;
  while (running()) {
    await clock.sleepUntil(t0 + deadline * periodMs);
    if (!running()) break;
    const start = clock.now();
    const taken = read();
    const end = clock.now();
    if (!taken) break;
    durations.push(end - start);
    deadline += 1;
    while (t0 + deadline * periodMs < end) {
      deadline += 1;
      missedTicks += 1;
    }
  }
  const sorted = durations.sort((a, b) => a - b);
  // Nearest rank, as PROTOCOL.md section 4: rank ceil(0.5 x N), counted from 1.
  const median = sorted[Math.ceil(0.5 * sorted.length) - 1] ?? 0;
  return { readings: durations.length, missedTicks, medianReadingMs: median };
}
