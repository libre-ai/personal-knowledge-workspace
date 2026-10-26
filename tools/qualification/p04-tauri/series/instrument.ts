// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The instrumentation script of the series binary (PROTOCOL.md section 10). It
// is injected into the page of the shell by `initialization_script` and drives
// the front through its DOM, as a person would: the folder button, the note
// form, the editor. It reports by the document title, one message per title,
// numbered so that a lost title is seen (`shell.ts`, `SequenceGuard`).
//
// It calls one bridge command of its own, `rebuild_index` (NFR-10: the index
// exists only after it), through the same IPC and ACL as the front. It reaches
// the CodeMirror view only to place the caret and to read the document, never
// to change the text: text comes from system keystrokes.
//
// The parts a measure depends on (the title channel, the frame period, the two
// end bounds of section 10.1, the visible area of section 10.3) are fragments
// of plain JavaScript exported on their own, so that `instrument.test.ts` runs
// the very code that is injected, on fakes of the page.

import { createHash } from "node:crypto";

export type Plan =
  | { mode: "round-trip"; paths: string[]; saveTimeoutMs: number }
  | { mode: "edit"; items: { path: string; offset: number }[]; text: string; saveTimeoutMs: number }
  | {
      mode: "latency";
      path: string;
      cycle: string;
      count: number;
      pauseMs: number;
      timeoutMs: number;
      controlBlockMs: number;
      frameIntervals: number;
    }
  /** `firstLines`: the first lines of the note, enough to cover the visible area; `lineCount`: all its lines. */
  | {
      mode: "open";
      path: string;
      firstLines: string[];
      lineCount: number;
      timeoutMs: number;
      frameIntervals: number;
    }
  | { mode: "memory"; path: string; holdMs: number; marksTimeoutMs: number }
  | { mode: "accessibility"; path: string };

export const REPORT_PREFIX = "P04SERIES ";
export const EXIT_TITLE = "P04SERIES-EXIT";

/**
 * The title channel. Page globals used: `document`, `setTimeout`. Defines
 * `emit`, `exit`, `sleep`, `drained` and `interrupted`.
 */
export const CHANNEL_SOURCE = `
  let sequence = 0;
  const queue = [];
  let pumping = false;
  const pump = () => {
    const next = queue.shift();
    if (next === undefined) {
      pumping = false;
      return;
    }
    document.title = next;
    setTimeout(pump, 0);
  };
  const send = (title) => {
    queue.push(title);
    if (!pumping) {
      pumping = true;
      pump();
    }
  };
  // WebKit cuts a document title at 1 000 characters (probe of 2026-10-24): a longer
  // report would arrive truncated, so it is replaced by an error the harness sees.
  const TITLE_LIMIT = 1000;
  let aborted = false;
  const emit = (type, data) => {
    if (aborted) return;
    let title = "P04SERIES " + JSON.stringify(Object.assign({ seq: sequence, type }, data || {}));
    if (title.length >= TITLE_LIMIT) {
      title = "P04SERIES " + JSON.stringify({ seq: sequence, type: "error", cause: "instrument-error", reason: "report " + type + " longer than the title limit" });
    }
    sequence += 1;
    send(title);
  };
  const exit = () => send("P04SERIES-EXIT");
  // An error that interrupts the run, with its cause of PROTOCOL.md section 10.7.
  const interrupted = (cause, reason) => Object.assign(new Error(reason), { interruption: cause });
  // WebKit stops requestAnimationFrame in a hidden window (PROTOCOL.md section 10.7):
  // the run is interrupted, never left waiting for a frame that does not come.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && !aborted) {
      queue.length = 0;
      emit("error", { cause: "page-hidden", reason: "window hidden" });
      aborted = true;
      exit();
    }
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A signal the harness answers at once must not wait behind earlier titles.
  const drained = async () => {
    while (pumping) await sleep(2);
  };
`;

/**
 * Frames outside the measured instants. Page globals used:
 * `requestAnimationFrame`, `performance`. Defines `frame`, `untilFrame` (waits
 * of the procedure, never during the keystrokes of AT-02) and
 * `recordFramePeriod`, the frame period of PROTOCOL.md section 10.1.
 */
export const FRAMES_SOURCE = `
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
  const untilFrame = async (predicate, timeoutMs) => {
    const start = performance.now();
    for (;;) {
      const now = await frame();
      const value = predicate();
      if (value) return { now, value };
      if (now - start > timeoutMs) return null;
    }
  };
  // Nearest rank, as PROTOCOL.md section 4: rank ceil(q x N), counted from 1.
  const nearestRank = (sorted, q) => sorted[Math.ceil(q * sorted.length) - 1];
  // The frame period at the start of a launch of AT-02 or NFR-03: the intervals between
  // successive callbacks, then no more callback is requested.
  const recordFramePeriod = (intervals) =>
    new Promise((resolve) => {
      const values = [];
      let last = null;
      const tick = () => {
        const now = performance.now();
        if (last !== null) values.push(now - last);
        last = now;
        if (values.length < intervals) {
          requestAnimationFrame(tick);
          return;
        }
        const sorted = values.slice().sort((a, b) => a - b);
        resolve({
          intervals: sorted.length,
          p50Ms: nearestRank(sorted, 0.5),
          p95Ms: nearestRank(sorted, 0.95),
          maxMs: sorted[sorted.length - 1],
        });
      };
      requestAnimationFrame(tick);
    });
`;

/**
 * The end bound of AT-02 (PROTOCOL.md section 10.1). Page globals used:
 * `MutationObserver`, `requestAnimationFrame`, `performance`, `setTimeout`,
 * `clearTimeout`. Resolves with `painted`, the time read first in the callback
 * requested as soon as the observer sees the change, and `observed`, the time of
 * that observation; null when the change is not seen within `timeoutMs`.
 */
export const KEYSTROKE_BOUND_SOURCE = `
  const paintedOnMutation = (content, predicate, timeoutMs) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      };
      const observer = new MutationObserver(() => {
        const observed = performance.now();
        if (done || !predicate()) return;
        observer.disconnect();
        requestAnimationFrame(() => {
          const painted = performance.now();
          finish({ painted, observed });
        });
      });
      observer.observe(content, { childList: true, subtree: true, characterData: true });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
`;

/**
 * The end bound of NFR-03 (PROTOCOL.md section 10.1). Page globals used:
 * `requestAnimationFrame`, `performance`. A callback is requested at once, then
 * from each callback while the end state is not reached; the time is read
 * before the state is evaluated. Resolves with `painted`, the time of the first
 * callback where `predicate` holds, its value, and `callbacks`, the callbacks
 * requested up to it; null when the state is not reached `timeoutMs` after `start`.
 */
export const OPEN_BOUND_SOURCE = `
  const paintedWhen = (start, predicate, timeoutMs) =>
    new Promise((resolve) => {
      let callbacks = 0;
      const tick = () => {
        const now = performance.now();
        const value = predicate();
        if (value) {
          resolve({ painted: now, value, callbacks });
          return;
        }
        if (now - start > timeoutMs) {
          resolve(null);
          return;
        }
        callbacks += 1;
        requestAnimationFrame(tick);
      };
      callbacks += 1;
      requestAnimationFrame(tick);
    });
`;

/**
 * NFR-03, the visible area rendered (PROTOCOL.md section 10.3), as a function of
 * the shadow root of the editor and of the height of the window: the area runs
 * from max(0, top of the scroller) to min(window height, bottom of the scroller),
 * in getBoundingClientRect() coordinates. Null while there is no scroller,
 * "shown" when the line elements that intersect the area are lines 1 to k of
 * the note, in order, with their text, and the bottom of line k is at the
 * bottom of the area or beyond, or k is the last line; "short-plan" when more
 * lines are visible than the plan carries.
 */
export const VISIBLE_AREA_SOURCE = `
  const visibleArea = (root, firstLines, lineCount, viewportHeight) => {
    const scroller = root && root.querySelector(".cm-scroller");
    if (!scroller) return null;
    // The scroller takes the height of the whole note and the window scrolls: the
    // visible area is the part of its box the window shows.
    const box = scroller.getBoundingClientRect();
    const area = { top: Math.max(0, box.top), bottom: Math.min(viewportHeight, box.bottom) };
    const lines = Array.from(root.querySelectorAll(".cm-content .cm-line")).filter((line) => {
      const box = line.getBoundingClientRect();
      return box.bottom > area.top && box.top < area.bottom;
    });
    if (lines.length === 0) return false;
    if (lines.length > firstLines.length) return "short-plan";
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].textContent !== firstLines[index]) return false;
    }
    const last = lines[lines.length - 1].getBoundingClientRect();
    return last.bottom >= area.bottom || lines.length === lineCount ? "shown" : false;
  };
`;

// Plain JavaScript: it runs in the page, not in Bun. `__PLAN__` is replaced by
// the JSON of the plan.
const SCRIPT = `(() => {
  "use strict";
  if (window.top !== window) return;
  const PLAN = __PLAN__;
  const OPEN_TIMEOUT_MS = 30000;

  // ---- title channel
${CHANNEL_SOURCE}
  // ---- frames outside the measured instants, frame period
${FRAMES_SOURCE}
  // ---- end bounds (PROTOCOL.md section 10.1)
${KEYSTROKE_BOUND_SOURCE}
${OPEN_BOUND_SOURCE}
  // ---- visible area (PROTOCOL.md section 10.3)
${VISIBLE_AREA_SOURCE}
  // ---- the front
  const byId = (id) => document.getElementById(id);
  const editorRoot = () => (byId("editor") && byId("editor").shadowRoot) || null;
  // CodeMirror 6.43 hangs the view off the tile of .cm-content (EditorView.findFromDOM).
  const editorView = () => {
    const root = editorRoot();
    const content = root && root.querySelector(".cm-content");
    const tile = content && content.cmTile;
    return (tile && tile.root && tile.root.view) || null;
  };
  const saveState = () => (byId("save-state") && byId("save-state").getAttribute("data-state")) || "";
  const problem = () => (byId("problem") && byId("problem").textContent) || "";
  const domReady = () =>
    new Promise((resolve) => {
      const check = () => (byId("choose-vault") ? resolve() : setTimeout(check, 10));
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check, { once: true });
      else check();
    });
  const chooseVault = async () => {
    byId("choose-vault").click();
    const chosen = await untilFrame(() => {
      const form = byId("open-form");
      if (form && !form.hidden) return "open";
      return problem() !== "" ? "refused" : false;
    }, OPEN_TIMEOUT_MS);
    if (chosen === null || chosen.value !== "open") throw new Error("the vault was not chosen: " + problem());
  };
  let previous = null;
  const submitOpen = (path) => {
    byId("note-path").value = path;
    byId("open-form").requestSubmit();
  };
  // Resolves with the new view, or null when the shell refuses the note.
  const openNote = async (path) => {
    submitOpen(path);
    const seen = await untilFrame(() => {
      const view = editorView();
      if (view !== null && view !== previous) return view;
      return problem() !== "" ? "refused" : false;
    }, OPEN_TIMEOUT_MS);
    if (seen === null) throw new Error("the note did not open: " + path);
    if (seen.value === "refused") return null;
    previous = seen.value;
    return seen.value;
  };
  const placeCaret = async (view, offset) => {
    view.dispatch({ selection: { anchor: offset }, scrollIntoView: true });
    view.focus();
    await frame();
    await frame();
  };
  const settled = () => saveState() !== "dirty" && saveState() !== "saving";
  // PROTOCOL.md section 10.7: the visibility is read at each sample.
  const visibleOrInterrupt = () => {
    if (document.visibilityState === "hidden") throw interrupted("page-hidden", "window hidden");
  };

  // ---- AT-01, round trip without edit
  const roundTrip = async () => {
    let opened = 0;
    let refused = 0;
    for (let index = 0; index < PLAN.paths.length; index += 1) {
      const view = await openNote(PLAN.paths[index]);
      if (view === null) refused += 1;
      else opened += 1;
      if ((await untilFrame(settled, PLAN.saveTimeoutMs)) === null) throw new Error("the save state did not settle");
      if (index % 500 === 0) emit("progress", { index });
    }
    emit("done", { opened, refused });
  };

  // ---- AT-01, paragraph edit
  const editAll = async () => {
    for (let index = 0; index < PLAN.items.length; index += 1) {
      const item = PLAN.items[index];
      const view = await openNote(item.path);
      if (view === null) {
        emit("edited", { index, state: "refused" });
        continue;
      }
      await placeCaret(view, item.offset);
      await drained();
      emit("ready-edit", { index, text: PLAN.text });
      const end = item.offset + PLAN.text.length;
      const typed = await untilFrame(() => view.state.doc.sliceString(item.offset, end) === PLAN.text, PLAN.saveTimeoutMs);
      if (typed === null) {
        emit("edited", { index, state: "not-typed" });
        continue;
      }
      // The blur handler of the editor writes at once (PROTOCOL.md section 10.5).
      view.contentDOM.blur();
      const saved = await untilFrame(() => {
        const state = saveState();
        return state === "saved" || state === "conflict" || state === "refused" || state === "failed" ? state : false;
      }, PLAN.saveTimeoutMs);
      emit("edited", { index, state: saved === null ? "timeout" : saved.value });
    }
    emit("done", {});
  };

  // ---- AT-02, system keystroke to the typed character painted
  const latency = async () => {
    const view = await openNote(PLAN.path);
    if (view === null) throw new Error("the note was refused: " + PLAN.path);
    const doc = view.state.doc;
    let caret = doc.line(Math.ceil(doc.lines / 2)).to;
    await placeCaret(view, caret);
    // The frame period, before any keystroke; then out of the rendering update.
    emit("frames", await recordFramePeriod(PLAN.frameIntervals));
    await sleep(0);
    const content = editorRoot().querySelector(".cm-content");
    let keydown = null;
    window.addEventListener("keydown", (event) => {
      keydown = event.timeStamp;
    }, true);
    // During the keystrokes the script requests no animation frame but the end bound's.
    const measure = async (character) => {
      keydown = null;
      const at = caret;
      let start = null;
      const seen = await paintedOnMutation(content, () => {
        if (keydown === null || view.state.doc.sliceString(at, at + 1) !== character) return false;
        start = keydown;
        return true;
      }, PLAN.timeoutMs);
      caret = view.state.selection.main.head;
      visibleOrInterrupt();
      if (seen === null || start === null) return { latency: null, gap: null };
      const value = seen.painted - start;
      if (value > PLAN.timeoutMs) return { latency: null, gap: null };
      return { latency: value, gap: seen.painted - seen.observed };
    };
    // Control of the start bound: signal, then block the main thread.
    const first = PLAN.cycle[0];
    await drained();
    emit("ready-control", { character: first });
    const blockStart = performance.now();
    while (performance.now() - blockStart < PLAN.controlBlockMs) {
      // busy: the keystroke posted at the signal waits in the queue
    }
    emit("control", await measure(first));
    for (let k = 0; k < PLAN.count; k += 1) {
      const character = PLAN.cycle[k % PLAN.cycle.length];
      await drained();
      emit("ready-key", { k, character });
      emit("key", Object.assign({ k }, await measure(character)));
      await sleep(PLAN.pauseMs);
    }
    emit("done", {});
  };

  // ---- NFR-03, first opening
  const openLatency = async () => {
    emit("frames", await recordFramePeriod(PLAN.frameIntervals));
    await sleep(0);
    const start = performance.now();
    const pending = paintedWhen(start, () => {
      const state = visibleArea(editorRoot(), PLAN.firstLines, PLAN.lineCount, window.innerHeight);
      if (state === null) return problem() !== "" ? "refused" : false;
      return state;
    }, PLAN.timeoutMs);
    submitOpen(PLAN.path);
    const seen = await pending;
    visibleOrInterrupt();
    if (seen !== null && seen.value === "short-plan") throw new Error("the visible area holds more lines than the plan");
    if (seen !== null && seen.value === "refused") throw new Error("the note was refused: " + problem());
    // Not reached within the timeout: +oo, the launch is not redone (PROTOCOL.md section 10.3).
    if (seen === null) emit("open", { latency: null, callbacks: null });
    else emit("open", { latency: seen.painted - start, callbacks: seen.callbacks });
  };

  // ---- NFR-10, memory scenario
  const memory = async () => {
    const stats = await window.__TAURI_INTERNALS__.invoke("rebuild_index");
    emit("index", { notes: stats && typeof stats.notes === "number" ? stats.notes : null });
    const view = await openNote(PLAN.path);
    if (view === null) throw new Error("the note was refused: " + PLAN.path);
    const marks = await untilFrame(() => {
      const root = editorRoot();
      return root !== null && root.querySelector(".cm-md") !== null;
    }, PLAN.marksTimeoutMs);
    if (marks === null) throw new Error("the preview marks were never applied");
    emit("steady", {});
    await sleep(PLAN.holdMs);
    emit("done", {});
  };

  // ---- accessibility: open, focus, and let the harness read
  const accessibility = async () => {
    const view = await openNote(PLAN.path);
    if (view === null) throw new Error("the note was refused: " + PLAN.path);
    await placeCaret(view, 0);
    emit("ready-ax", {});
  };

  const scenarios = { "round-trip": roundTrip, edit: editAll, latency, open: openLatency, memory, accessibility };
  domReady()
    .then(async () => {
      await chooseVault();
      await scenarios[PLAN.mode]();
      if (PLAN.mode !== "accessibility") {
        await drained();
        exit();
      }
    })
    .catch(async (error) => {
      await drained();
      const cause = error && error.interruption ? error.interruption : "instrument-error";
      emit("error", { cause, reason: String(error && error.message ? error.message : error) });
      exit();
    });
})();
`;

/**
 * The SHA-256 of the instrumentation script before its plan is put in: part of
 * the identity of the instrument (PROTOCOL.md section 10.7), the same for
 * every launch of a series.
 */
export const SCRIPT_SHA256 = createHash("sha256").update(SCRIPT).digest("hex");

export function instrumentationScript(plan: Plan): string {
  return SCRIPT.replace("__PLAN__", () => JSON.stringify(plan));
}
