// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import { SeriesStopped, Streak, Unavailable } from "./attempts";
import { type LaunchSteps, Rejected, withLaunch } from "./launch";
import type { RejectionCause } from "./manifest";
import type { ProcessTable } from "./memory";

interface Fake {
  log: string[];
  steps: LaunchSteps<{ stop(): Promise<void> }>;
  context: { rejected: Record<RejectionCause, number>; streak: Streak; unit: string };
}

// Each call is logged, so the order of the rejection reads, of the table read
// "before", of the launch and of the stop can be asserted.
function fake(rejections: (RejectionCause | null)[]): Fake {
  const log: string[] = [];
  let launches = 0;
  return {
    log,
    context: {
      rejected: { "session-locked": 0, "display-asleep": 0, "helpers-unattributed": 0 },
      streak: new Streak(3),
      unit: "nfr-10 launch 0",
    },
    steps: {
      rejection: () => {
        const cause = rejections.shift() ?? null;
        log.push(`rejection:${cause ?? "none"}`);
        return cause;
      },
      readTable: () => {
        log.push("table");
        return new Map() as ProcessTable;
      },
      launch: () => {
        launches += 1;
        const launch = launches;
        log.push(`launch:${launch}`);
        return {
          stop: async () => {
            log.push(`stop:${launch}`);
          },
        };
      },
      pause: async () => {
        log.push("pause");
      },
    },
  };
}

// PROTOCOL.md section 10.4: the table read "before" is the last operation before
// the shell process is created; it follows the rejection reads (section 10.7) and
// the exit of the previous launch's process.
describe("one launch with the rejection rule (PROTOCOL.md sections 10.4 and 10.7)", () => {
  test("the table before follows the rejection read and precedes the launch", async () => {
    const { log, steps, context } = fake([null, null]);
    const value = await withLaunch(steps, context, async () => {
      log.push("body");
      return 7;
    });
    expect(value).toBe(7);
    expect(log).toEqual([
      "rejection:none",
      "table",
      "launch:1",
      "body",
      "rejection:none",
      "stop:1",
    ]);
  });

  test("a launch rejected after its body is stopped before the next table is read", async () => {
    const { log, steps, context } = fake([null, "display-asleep", null, null]);
    await withLaunch(steps, context, async () => "sample");
    expect(context.rejected["display-asleep"]).toBe(1);
    const stop = log.indexOf("stop:1");
    const secondTable = log.lastIndexOf("table");
    expect(stop).toBeGreaterThan(-1);
    expect(secondTable).toBeGreaterThan(stop);
    expect(log.indexOf("launch:2")).toBe(secondTable + 1);
  });

  test("a rejection read before the launch is counted, and nothing is launched", async () => {
    const { log, steps, context } = fake(["session-locked", null, null]);
    await withLaunch(steps, context, async () => 1);
    expect(context.rejected["session-locked"]).toBe(1);
    expect(log.slice(0, 4)).toEqual([
      "rejection:session-locked",
      "pause",
      "rejection:none",
      "table",
    ]);
  });

  test("a body that cannot attribute the helpers is a rejection, counted by its cause", async () => {
    const { steps, context } = fake([null, null, null, null]);
    let calls = 0;
    const value = await withLaunch(steps, context, async () => {
      calls += 1;
      return calls === 1 ? new Rejected("helpers-unattributed") : "second";
    });
    expect(value).toBe("second");
    expect(context.rejected).toEqual({
      "session-locked": 0,
      "display-asleep": 0,
      "helpers-unattributed": 1,
    });
  });

  // PROTOCOL.md section 10.7: three rejections in a row of one cause stop the series.
  test("three rejections of one cause in a row stop the series", async () => {
    const { steps, context } = fake(Array.from({ length: 10 }, () => "session-locked" as const));
    const stopped = await withLaunch(steps, context, async () => 1).then(
      () => null,
      (error: unknown) => error,
    );
    expect(stopped).toBeInstanceOf(SeriesStopped);
    expect(stopped).toMatchObject({ cause: "session-locked", unit: "nfr-10 launch 0" });
    expect(context.rejected["session-locked"]).toBe(3);
  });

  test("rejections of alternating causes end unavailable at the bound of the harness", async () => {
    const causes = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? ("session-locked" as const) : ("display-asleep" as const),
    );
    const { steps, context } = fake(causes);
    await expect(withLaunch(steps, context, async () => 1, 4)).rejects.toBeInstanceOf(Unavailable);
  });
});
