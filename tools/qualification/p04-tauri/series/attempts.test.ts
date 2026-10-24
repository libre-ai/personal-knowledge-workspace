// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import {
  Interrupted,
  type Interruption,
  MAX_ATTEMPTS,
  SeriesStopped,
  Streak,
  Unavailable,
  untilCompleted,
} from "./attempts";

// PROTOCOL.md sections 5, 10.2 and 10.7: a pass, a configuration or a launch
// interrupted is recorded with its cause and redone; it is never a sample.
describe("an interrupted attempt is recorded and redone", () => {
  test("two interruptions of different causes, then a completed attempt", async () => {
    const interruptions: Interruption[] = [];
    let calls = 0;
    const value = await untilCompleted(
      "at-01 pass 3",
      async (attempt) => {
        calls += 1;
        if (attempt === 1) throw new Interrupted("page-hidden", "window hidden");
        if (attempt === 2) throw new Error("series: a report is not an object");
        return attempt;
      },
      interruptions,
      new Streak(),
    );
    expect(value).toBe(3);
    expect(calls).toBe(3);
    expect(interruptions).toEqual([
      { unit: "at-01 pass 3", attempt: 1, cause: "page-hidden", reason: "window hidden" },
      // An exception of the harness or the script is an instrument error, with its message.
      {
        unit: "at-01 pass 3",
        attempt: 2,
        cause: "instrument-error",
        reason: "series: a report is not an object",
      },
    ]);
  });

  test("a completed first attempt records nothing", async () => {
    const interruptions: Interruption[] = [];
    expect(
      await untilCompleted("nfr-03 launch 0", async () => "ok", interruptions, new Streak()),
    ).toBe("ok");
    expect(interruptions).toEqual([]);
  });

  test("an unavailable measure is not an interruption: it is not redone", async () => {
    const interruptions: Interruption[] = [];
    let calls = 0;
    const run = untilCompleted(
      "at-02-1-mib configuration",
      async () => {
        calls += 1;
        throw new Unavailable("AXIsProcessTrusted() is false");
      },
      interruptions,
      new Streak(),
    );
    await expect(run).rejects.toBeInstanceOf(Unavailable);
    expect(calls).toBe(1);
    expect(interruptions).toEqual([]);
  });

  test("causes that alternate never stop the series, but the unit ends unavailable at the bound", async () => {
    const interruptions: Interruption[] = [];
    const causes = ["page-hidden", "instrument-error"] as const;
    const run = untilCompleted(
      "at-01 pass 0",
      async (attempt) => {
        throw new Interrupted(causes[attempt % 2] ?? "page-hidden", "alternating");
      },
      interruptions,
      new Streak(),
    );
    await expect(run).rejects.toBeInstanceOf(Unavailable);
    expect(interruptions).toHaveLength(MAX_ATTEMPTS);
  });
});

// PROTOCOL.md section 10.7: three rejections or interruptions in a row of the same
// cause stop the series, recorded with that cause.
describe("three consecutive interruptions of one cause stop the series", () => {
  test("the third shell-not-frontmost in a row stops the series with its cause and unit", async () => {
    const interruptions: Interruption[] = [];
    const run = untilCompleted(
      "at-02-5000-lines configuration",
      async () => {
        throw new Interrupted("shell-not-frontmost", "pid 1 is frontmost");
      },
      interruptions,
      new Streak(),
    );
    const stopped = await run.then(
      () => null,
      (error: unknown) => error,
    );
    expect(stopped).toBeInstanceOf(SeriesStopped);
    expect(stopped).toMatchObject({
      cause: "shell-not-frontmost",
      unit: "at-02-5000-lines configuration",
    });
    expect(interruptions).toHaveLength(3);
  });

  test("the run spans units: two at the end of one unit and one at the start of the next stop it", async () => {
    const streak = new Streak();
    streak.record("page-hidden", "nfr-03 launch 4");
    streak.record("page-hidden", "nfr-03 launch 4");
    expect(() => streak.record("page-hidden", "nfr-03 launch 5")).toThrow(SeriesStopped);
  });

  test("a completed unit ends the run", async () => {
    const streak = new Streak();
    streak.record("session-locked", "nfr-10 launch 0");
    streak.record("session-locked", "nfr-10 launch 0");
    await untilCompleted("nfr-10 launch 0", async () => 1, [], streak);
    streak.record("session-locked", "nfr-10 launch 1");
    expect(() => streak.record("session-locked", "nfr-10 launch 1")).not.toThrow();
  });

  test("a cause that changes restarts the count", () => {
    const streak = new Streak();
    streak.record("session-locked", "u");
    streak.record("session-locked", "u");
    streak.record("display-asleep", "u");
    expect(() => streak.record("session-locked", "u")).not.toThrow();
  });
});
