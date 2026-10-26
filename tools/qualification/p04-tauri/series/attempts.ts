// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The resumption rules of PROTOCOL.md. An AT-01 pass interrupted by an error is
// not counted, it is recorded and redone until 20 passes are completed (section
// 5); an AT-02 configuration interrupted by an instrument error is recorded and
// redone (section 10.2); a pass, a configuration or a launch interrupted for a
// cause of the closed set of section 10.7 is recorded and redone. An
// interruption is never a sample. Three rejections or interruptions in a row of
// the same cause stop the series, which is recorded with that cause and no
// verdict (section 10.7).
//
// `Unavailable` is neither: the measure cannot be made here (no Accessibility
// permission, a start-bound control that fails) and is written as unavailable,
// never redone.

import { INTERRUPTION_CAUSES, type InterruptionCause, type StopCause } from "./manifest";

export class Unavailable extends Error {}

/** An attempt stopped for a cause of the closed set of PROTOCOL.md section 10.7. */
export class Interrupted extends Error {
  constructor(
    readonly cause: InterruptionCause,
    reason: string,
  ) {
    super(reason);
  }
}

/** Three rejections or interruptions of one cause in a row: the series stops (section 10.7). */
export class SeriesStopped extends Error {
  constructor(
    readonly cause: StopCause,
    readonly unit: string,
  ) {
    super(`series stopped: 3 consecutive ${cause} at ${unit}`);
  }
}

/**
 * The run of consecutive rejections and interruptions of one cause, over the
 * whole series. `consecutive` is `series-stop-consecutive` of PROTOCOL.md section 1.
 */
export class Streak {
  #cause: StopCause | null = null;
  #count = 0;

  constructor(readonly consecutive: number) {}

  /** Records one rejection or interruption; the third of one cause in a row throws SeriesStopped. */
  record(cause: StopCause, unit: string): void {
    if (cause === this.#cause) this.#count += 1;
    else {
      this.#cause = cause;
      this.#count = 1;
    }
    if (this.#count >= this.consecutive) throw new SeriesStopped(cause, unit);
  }

  /** A completed pass, configuration or launch ends the run. */
  reset(): void {
    this.#cause = null;
    this.#count = 0;
  }
}

/** An attempt that did not complete, recorded in the raw output of its measure. */
export interface Interruption {
  /** What was being made: "at-01 pass 3", "nfr-03 launch 12", "at-02-1-mib configuration"... */
  unit: string;
  /** 1 for the first attempt of the unit. */
  attempt: number;
  cause: InterruptionCause;
  reason: string;
}

/**
 * The cause of an error that interrupted an attempt: an exception of the
 * harness or of the script (a report that does not come or does not parse) is
 * an instrument error, recorded with its message (PROTOCOL.md section 10.7).
 */
export function causeOf(error: unknown): InterruptionCause {
  if (error instanceof Interrupted) return error.cause;
  return "instrument-error";
}

export function isInterruptionCause(value: unknown): value is InterruptionCause {
  return (INTERRUPTION_CAUSES as readonly unknown[]).includes(value);
}

/**
 * The harness must end even when causes alternate and no streak reaches 3: a
 * unit interrupted this many times makes its measure unavailable (incomplete for
 * check-report.ts, never a pass).
 * shortcut: a bound of the harness, not a protocol value; upgrade trigger: a
 * series whose report shows a unit reaching it.
 */
export const MAX_ATTEMPTS = 10;

export async function untilCompleted<T>(
  unit: string,
  attempt: (number: number) => Promise<T>,
  interruptions: Interruption[],
  streak: Streak,
  maxAttempts: number = MAX_ATTEMPTS,
): Promise<T> {
  let last = "";
  for (let number = 1; number <= maxAttempts; number += 1) {
    let value: T;
    try {
      value = await attempt(number);
    } catch (error) {
      if (error instanceof Unavailable || error instanceof SeriesStopped) throw error;
      last = error instanceof Error ? error.message : String(error);
      const cause = causeOf(error);
      interruptions.push({ unit, attempt: number, cause, reason: last });
      console.log(`series: ${unit}: attempt ${number} interrupted (${cause}): ${last}`);
      streak.record(cause, unit);
      continue;
    }
    streak.reset();
    return value;
  }
  throw new Unavailable(`${unit}: ${maxAttempts} attempts interrupted, last: ${last}`);
}
