// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CHANNEL_SOURCE,
  FRAMES_SOURCE,
  instrumentationScript,
  KEYSTROKE_BOUND_SOURCE,
  OPEN_BOUND_SOURCE,
  type Plan,
  SCRIPT_SHA256,
  VISIBLE_AREA_SOURCE,
} from "./instrument";
import { parseEventLine, SequenceGuard, scriptError, shellExited } from "./shell";

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
    frameIntervals: 600,
  },
  {
    mode: "open",
    path: "a.md",
    firstLines: ["# Title </script>", "", "text"],
    lineCount: 3,
    timeoutMs: 2000,
    frameIntervals: 600,
  },
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

  // PROTOCOL.md section 10.7: the instrument is identified in the manifest.
  test("the script fingerprint is the SHA-256 of the script without its plan", () => {
    const script = instrumentationScript(plans[0] as Plan);
    const plan = JSON.stringify(plans[0]);
    const template = script.replace(plan, "__PLAN__");
    expect(SCRIPT_SHA256).toBe(createHash("sha256").update(template).digest("hex"));
    expect(
      instrumentationScript(plans[3] as Plan).replace(JSON.stringify(plans[3]), "__PLAN__"),
    ).toBe(template);
  });

  test("the script carries every fragment tested below", () => {
    const script = instrumentationScript(plans[2] as Plan);
    for (const fragment of [
      CHANNEL_SOURCE,
      FRAMES_SOURCE,
      KEYSTROKE_BOUND_SOURCE,
      OPEN_BOUND_SOURCE,
      VISIBLE_AREA_SOURCE,
    ]) {
      expect(script).toContain(fragment);
    }
  });
});

describe("the hook to the CodeMirror view exists in the pinned @codemirror/view", () => {
  const desktop = join(import.meta.dir, "..", "..", "..", "..", "apps", "desktop");
  const entry = Bun.resolveSync("@codemirror/view", desktop);
  const source = readFileSync(entry, "utf8");
  const script = instrumentationScript(plans[5] as Plan);

  test("the resolved package is the version pinned by apps/desktop", () => {
    const pinned = (
      JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      }
    ).dependencies["@codemirror/view"];
    const installed = (
      JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    expect(installed).toBe(pinned ?? "");
  });

  // EditorView.findFromDOM reads the tile of .cm-content through Tile.get, then tile.root.view.
  test("the script reads the same DOM property and path as EditorView.findFromDOM", () => {
    const property = /static get\(dom\) \{\s*return dom\.([A-Za-z]+);/.exec(source)?.[1];
    expect(property).toBeDefined();
    expect(source).toContain(`dom.${property} = this;`);
    const findFromDOM = /static findFromDOM\(dom\) \{([\s\S]*?)\n {4}\}/.exec(source)?.[1] ?? "";
    expect(findFromDOM).toContain('querySelector(".cm-content")');
    expect(findFromDOM).toContain(".root");
    expect(findFromDOM).toContain(".view");
    expect(script).toContain(`content.${property}`);
    expect(script).toContain("tile.root.view");
  });
});

// The fragments of the script run here on fakes of the page: `new Function` binds
// the page globals they use to the fakes, so the code tested is the code injected.
function load<T>(source: string, names: string[], globals: Record<string, unknown>): T {
  const factory = new Function(
    ...Object.keys(globals),
    `"use strict";\n${source}\nreturn { ${names.join(", ")} };`,
  );
  return factory(...Object.values(globals)) as T;
}

const settle = () => Bun.sleep(1);

interface FakeDocument {
  titles: string[];
  visibilityState: string;
  listeners: Map<string, () => void>;
}

function fakeDocument(): FakeDocument & Record<string, unknown> {
  const page: FakeDocument & Record<string, unknown> = {
    titles: [],
    visibilityState: "visible",
    listeners: new Map(),
    addEventListener(type: string, listener: () => void) {
      page.listeners.set(type, listener);
    },
  };
  Object.defineProperty(page, "title", {
    set(value: string) {
      page.titles.push(value);
    },
  });
  return page;
}

// A page whose animation frames run only when the test ticks the clock.
function fakeFrames() {
  let clock = 0;
  let callbacks: (() => void)[] = [];
  let requested = 0;
  return {
    globals: {
      requestAnimationFrame: (callback: () => void) => {
        requested += 1;
        callbacks.push(callback);
      },
      performance: { now: () => clock },
    },
    advance(ms: number) {
      clock += ms;
    },
    get requested() {
      return requested;
    },
    get pending() {
      return callbacks.length;
    },
    async tick(period = 16) {
      clock += period;
      const due = callbacks;
      callbacks = [];
      for (const callback of due) callback();
      await settle();
    },
  };
}

interface Channel {
  emit: (type: string, data?: Record<string, unknown>) => void;
  drained: () => Promise<void>;
}

describe("the title channel of the script (probe of 2026-10-24)", () => {
  test("a report of 1 000 characters or more is replaced by an error: WebKit cuts titles at 1 000", async () => {
    const document = fakeDocument();
    const { emit, drained } = load<Channel>(CHANNEL_SOURCE, ["emit", "drained"], {
      document,
      setTimeout,
    });
    emit("short", { text: "x" });
    emit("long", { text: "x".repeat(1000) });
    await drained();
    expect(document.titles[0]).toBe('P04SERIES {"seq":0,"type":"short","text":"x"}');
    const replaced = parseEventLine(document.titles[1] ?? "");
    expect(replaced).toMatchObject({ seq: 1, type: "error", cause: "instrument-error" });
    expect(String(replaced?.reason)).toContain("long");
    expect((document.titles[1] ?? "").length).toBeLessThan(1000);
  });

  // PROTOCOL.md section 10.7: page-hidden, read at each visibilitychange.
  test("a hidden page interrupts the run with the cause page-hidden, and nothing follows", async () => {
    const document = fakeDocument();
    const { emit, drained } = load<Channel>(CHANNEL_SOURCE, ["emit", "drained"], {
      document,
      setTimeout,
    });
    emit("progress", { index: 0 });
    await drained();
    document.visibilityState = "hidden";
    document.listeners.get("visibilitychange")?.();
    emit("key", { k: 0, latency: 3 });
    await drained();
    expect(document.titles.slice(1)).toEqual([
      'P04SERIES {"seq":1,"type":"error","cause":"page-hidden","reason":"window hidden"}',
      "P04SERIES-EXIT",
    ]);
  });
});

interface Frames {
  recordFramePeriod: (
    intervals: number,
  ) => Promise<{ intervals: number; p50Ms: number; p95Ms: number; maxMs: number }>;
}

// PROTOCOL.md section 10.1: the frame period at the start of a launch of AT-02 and
// of NFR-03, 600 intervals between successive callbacks.
describe("the frame period read at the start of a launch", () => {
  test("count, nearest-rank p50 and p95, and maximum of the intervals; then no callback is requested", async () => {
    const page = fakeFrames();
    const { recordFramePeriod } = load<Frames>(FRAMES_SOURCE, ["recordFramePeriod"], page.globals);
    const period = recordFramePeriod(20);
    // The first callback opens the record; 20 intervals follow: 18 of 16 ms, one 17, one 40.
    await page.tick(16);
    for (let index = 0; index < 18; index += 1) await page.tick(16);
    await page.tick(17);
    await page.tick(40);
    expect(await period).toEqual({ intervals: 20, p50Ms: 16, p95Ms: 17, maxMs: 40 });
    expect(page.pending).toBe(0);
  });
});

interface KeystrokeBound {
  paintedOnMutation: (
    content: unknown,
    predicate: () => boolean,
    timeoutMs: number,
  ) => Promise<{ painted: number; observed: number } | null>;
}

// A MutationObserver whose callback the test fires, as WebKit does after a change.
function fakeObservers() {
  const observers: {
    callback: () => void;
    target: unknown;
    options: unknown;
    connected: boolean;
  }[] = [];
  class FakeMutationObserver {
    #entry: (typeof observers)[number];
    constructor(callback: () => void) {
      this.#entry = { callback, target: null, options: null, connected: false };
      observers.push(this.#entry);
    }
    observe(target: unknown, options: unknown) {
      Object.assign(this.#entry, { target, options, connected: true });
    }
    disconnect() {
      this.#entry.connected = false;
    }
  }
  return {
    MutationObserver: FakeMutationObserver,
    observers,
    fire() {
      for (const entry of observers) if (entry.connected) entry.callback();
    },
  };
}

// PROTOCOL.md section 10.1, AT-02: the bound is performance.now() read first in the
// callback requested as soon as the observer of .cm-content sees the change.
describe("the end bound of AT-02", () => {
  function setup() {
    const page = fakeFrames();
    const dom = fakeObservers();
    const { paintedOnMutation } = load<KeystrokeBound>(
      KEYSTROKE_BOUND_SOURCE,
      ["paintedOnMutation"],
      {
        ...page.globals,
        MutationObserver: dom.MutationObserver,
        setTimeout,
        clearTimeout,
      },
    );
    return { page, dom, paintedOnMutation };
  }

  test("the observer watches the content element with childList, subtree and characterData", () => {
    const { dom, paintedOnMutation } = setup();
    const content = { name: ".cm-content" };
    void paintedOnMutation(content, () => false, 50);
    expect(dom.observers[0]?.target).toBe(content);
    expect(dom.observers[0]?.options).toEqual({
      childList: true,
      subtree: true,
      characterData: true,
    });
  });

  test("painted is the first callback after the observation, not the one requested from it", async () => {
    const { page, dom, paintedOnMutation } = setup();
    let typed = false;
    const seen = paintedOnMutation({}, () => typed, 2000);
    await page.tick(); // 16: no change, and no callback was requested
    expect(page.requested).toBe(0);
    page.advance(5);
    dom.fire(); // 21: a mutation that is not the typed character
    expect(page.requested).toBe(0);
    typed = true;
    page.advance(3);
    dom.fire(); // 24: the typed character is in the DOM
    await page.tick(8); // 32: the first callback after the observation
    await page.tick(); // 48: the callback a second frame would read
    expect(await seen).toEqual({ painted: 32, observed: 24 });
    expect(page.requested).toBe(1);
  });

  test("no change within the timeout gives null", async () => {
    const { paintedOnMutation } = setup();
    expect(await paintedOnMutation({}, () => false, 5)).toBeNull();
  });
});

interface OpenBound {
  paintedWhen: (
    start: number,
    predicate: () => unknown,
    timeoutMs: number,
  ) => Promise<{ painted: number; value: unknown; callbacks: number } | null>;
}

// PROTOCOL.md section 10.1, NFR-03: a callback from the start bound, then one from
// each callback until the end state; the time is read before the state; the report
// counts the callbacks requested up to the bound.
describe("the end bound of NFR-03", () => {
  test("the bound is the first callback where the end state holds, with the callbacks requested", async () => {
    const page = fakeFrames();
    const { paintedWhen } = load<OpenBound>(OPEN_BOUND_SOURCE, ["paintedWhen"], page.globals);
    let calls = 0;
    // The state is evaluated after the time is read: at the third callback it holds.
    const seen = paintedWhen(
      0,
      () => {
        calls += 1;
        return calls === 3 ? "shown" : false;
      },
      2000,
    );
    await page.tick(); // 16
    await page.tick(); // 32
    await page.tick(); // 48: reached
    await page.tick(); // 64: nothing more is requested
    expect(await seen).toEqual({ painted: 48, value: "shown", callbacks: 3 });
    expect(page.requested).toBe(3);
  });

  test("an end state not reached 2 000 ms after the start bound gives null (+oo)", async () => {
    const page = fakeFrames();
    const { paintedWhen } = load<OpenBound>(OPEN_BOUND_SOURCE, ["paintedWhen"], page.globals);
    const seen = paintedWhen(0, () => false, 2000);
    await page.tick(1000);
    await page.tick(1000);
    await page.tick(1);
    expect(await seen).toBeNull();
  });
});

// PROTOCOL.md section 10.3: the visible area is rendered when the line elements that
// intersect the scroller are lines 1 to k of the note, in order, each with the text
// of the note's line, and the bottom of line k is at the bottom of the area or beyond.
describe("NFR-03: the visible area rendered", () => {
  type State = "shown" | "short-plan" | false | null;
  const { visibleArea } = load<{
    visibleArea: (root: unknown, firstLines: string[], lineCount: number) => State;
  }>(VISIBLE_AREA_SOURCE, ["visibleArea"], {});

  const box = (top: number, bottom: number) => () => ({ top, bottom });
  // Lines of `lineHeight` px from the top of a scroller of `height` px.
  function root(texts: string[], height = 100, lineHeight = 20) {
    const lines = texts.map((textContent, index) => ({
      textContent,
      getBoundingClientRect: box(index * lineHeight, (index + 1) * lineHeight),
    }));
    return {
      querySelector: (selector: string) =>
        selector === ".cm-scroller" ? { getBoundingClientRect: box(0, height) } : null,
      querySelectorAll: (selector: string) => (selector === ".cm-content .cm-line" ? lines : []),
    };
  }
  const note = ["# large", "", "one", "two", "three", "four", "five"];

  test("lines 1 to k with their text, line k reaching the bottom: shown", () => {
    expect(visibleArea(root(note), note, note.length)).toBe("shown");
  });

  test("line k cut by the bottom of the scroller: shown", () => {
    // Lines of 30 px in 100 px: line 4 spans 90 to 120.
    expect(visibleArea(root(note, 100, 30), note, note.length)).toBe("shown");
  });

  test("the first lines alone, the area not filled: not yet", () => {
    expect(visibleArea(root(note.slice(0, 1)), note, note.length)).toBe(false);
    expect(visibleArea(root(note.slice(0, 3)), note, note.length)).toBe(false);
  });

  test("a short note, all its lines rendered above the bottom: shown", () => {
    const short = ["# short", "text"];
    expect(visibleArea(root(short), short, short.length)).toBe("shown");
  });

  test("a line whose text differs from the note: not yet", () => {
    const wrong = [...note];
    wrong[3] = "tw";
    expect(visibleArea(root(wrong), note, note.length)).toBe(false);
  });

  test("lines that do not start at line 1 of the note: not yet", () => {
    expect(visibleArea(root(note.slice(1)), note, note.length)).toBe(false);
  });

  test("more visible lines than the plan carries: an instrument error, never shown", () => {
    expect(visibleArea(root(note), note.slice(0, 2), note.length)).toBe("short-plan");
  });

  test("no scroller yet: not mounted", () => {
    expect(visibleArea(null, note, note.length)).toBeNull();
    expect(
      visibleArea({ querySelector: () => null, querySelectorAll: () => [] }, note, note.length),
    ).toBeNull();
  });
});

describe("title channel", () => {
  test("a report line parses, other lines are ignored", () => {
    expect(parseEventLine('P04SERIES {"seq":0,"type":"done"}')).toEqual({ seq: 0, type: "done" });
    expect(parseEventLine("Libre AI Knowledge Workspace")).toBeNull();
    expect(() => parseEventLine("P04SERIES {not json")).toThrow();
    expect(() => parseEventLine('P04SERIES {"type":"done"}')).toThrow();
  });

  // PROTOCOL.md section 10.7: the cause the script names is kept; anything else is
  // an instrument error, with the script's message.
  test("an error report becomes an interruption with its cause of the closed set", () => {
    expect(
      scriptError({ seq: 3, type: "error", cause: "page-hidden", reason: "window hidden" }),
    ).toMatchObject({ cause: "page-hidden", message: "series script: window hidden" });
    expect(scriptError({ seq: 3, type: "error", cause: "window-gone", reason: "x" })).toMatchObject(
      {
        cause: "instrument-error",
      },
    );
    expect(scriptError({ seq: 3, type: "error", reason: "TypeError" })).toMatchObject({
      cause: "instrument-error",
      message: "series script: TypeError",
    });
  });

  test("a shell that exits before the planned end is the cause shell-exited", () => {
    expect(shellExited(1)).toMatchObject({ cause: "shell-exited" });
  });

  test("a gap in the sequence is an instrument error: a title was lost", () => {
    const guard = new SequenceGuard();
    guard.accept({ seq: 0, type: "a" });
    guard.accept({ seq: 1, type: "b" });
    expect(() => guard.accept({ seq: 3, type: "c" })).toThrow("seq");
  });
});
