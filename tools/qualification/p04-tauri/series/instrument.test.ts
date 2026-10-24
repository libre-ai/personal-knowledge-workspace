// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";

import { instrumentationScript, type Plan } from "./instrument";
import { parseEventLine, SequenceGuard } from "./shell";

const plans: Plan[] = [
  { mode: "round-trip", paths: ["notes/00/note-00000.md"], saveTimeoutMs: 10000 },
  { mode: "edit", items: [{ path: "a.md", offset: 3 }], text: "p04", saveTimeoutMs: 10000 },
  {
    mode: "latency",
    path: "a.md",
    cycle: "ab",
    count: 3,
    pauseMs: 150,
    timeoutMs: 2000,
    controlBlockMs: 500,
  },
  { mode: "open", path: "a.md", firstLine: "# Title </script>" },
  { mode: "memory", path: "a.md", holdMs: 5000, marksTimeoutMs: 10000 },
  { mode: "accessibility", path: "a.md" },
];

describe("instrumentation script", () => {
  for (const plan of plans) {
    test(`${plan.mode}: the script is valid JavaScript and carries its plan`, () => {
      const script = instrumentationScript(plan);
      // Parsing only: the function is never called here.
      expect(() => new Function(script)).not.toThrow();
      expect(script).toContain(JSON.stringify(plan.mode));
    });
  }

  test("the script reaches nothing outside the page: no network API, no eval", () => {
    const script = instrumentationScript(plans[0] as Plan);
    for (const name of [
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "sendBeacon",
      "eval(",
      "import(",
    ]) {
      expect(script).not.toContain(name);
    }
  });

  test("the only bridge command it calls is rebuild_index", () => {
    const script = instrumentationScript(plans[4] as Plan);
    const invoked = [...script.matchAll(/invoke\("([a-z_]+)"/g)].map((match) => match[1]);
    expect(invoked).toEqual(["rebuild_index"]);
  });
});

describe("title channel", () => {
  test("a report line parses, other lines are ignored", () => {
    expect(parseEventLine('P04SERIES {"seq":0,"type":"done"}')).toEqual({ seq: 0, type: "done" });
    expect(parseEventLine("Libre AI Knowledge Workspace")).toBeNull();
    expect(() => parseEventLine("P04SERIES {not json")).toThrow();
    expect(() => parseEventLine('P04SERIES {"type":"done"}')).toThrow();
  });

  test("a gap in the sequence is an instrument error: a title was lost", () => {
    const guard = new SequenceGuard();
    guard.accept({ seq: 0, type: "a" });
    guard.accept({ seq: 1, type: "b" });
    expect(() => guard.accept({ seq: 3, type: "c" })).toThrow("seq");
  });
});
