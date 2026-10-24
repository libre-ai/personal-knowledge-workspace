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
    }
  | { mode: "open"; path: string; firstLine: string }
  | { mode: "memory"; path: string; holdMs: number; marksTimeoutMs: number }
  | { mode: "accessibility"; path: string };

export const REPORT_PREFIX = "P04SERIES ";
export const EXIT_TITLE = "P04SERIES-EXIT";

// Plain JavaScript: it runs in the page, not in Bun. `__PLAN__` is replaced by
// the JSON of the plan.
const SCRIPT = `(() => {
  "use strict";
  if (window.top !== window) return;
  const PLAN = __PLAN__;
  const OPEN_TIMEOUT_MS = 30000;

  // ---- title channel
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
  const emit = (type, data) => send("P04SERIES " + JSON.stringify(Object.assign({ seq: sequence++, type }, data || {})));
  const exit = () => send("P04SERIES-EXIT");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A signal the harness answers at once must not wait behind earlier titles.
  const drained = async () => {
    while (pumping) await sleep(2);
  };

  // ---- frames (PROTOCOL.md section 10.1)
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(performance.now())));
  // Polls once per animation frame until the predicate holds: the frame where it
  // first holds is the first one to run after the change.
  const untilFrame = async (predicate, timeoutMs) => {
    const start = performance.now();
    for (;;) {
      const now = await frame();
      const value = predicate();
      if (value) return { now, value };
      if (now - start > timeoutMs) return null;
    }
  };
  // The painted instant: performance.now() of the frame requested from that first frame.
  const paintedAfter = async (predicate, timeoutMs) => {
    const seen = await untilFrame(predicate, timeoutMs);
    if (seen === null) return null;
    const painted = await frame();
    return { painted, value: seen.value };
  };

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
    let keydown = null;
    window.addEventListener("keydown", (event) => {
      keydown = event.timeStamp;
    }, true);
    const measure = async (character) => {
      keydown = null;
      const at = caret;
      let start = null;
      const seen = await paintedAfter(() => {
        if (keydown === null || view.state.doc.sliceString(at, at + 1) !== character) return false;
        start = keydown;
        return true;
      }, PLAN.timeoutMs);
      caret = view.state.selection.main.head;
      if (seen === null || start === null) return null;
      const value = seen.painted - start;
      return value > PLAN.timeoutMs ? null : value;
    };
    // Control of the start bound: signal, then block the main thread.
    const first = PLAN.cycle[0];
    await drained();
    emit("ready-control", { character: first });
    const blockStart = performance.now();
    while (performance.now() - blockStart < PLAN.controlBlockMs) {
      // busy: the keystroke posted at the signal waits in the queue
    }
    emit("control", { latency: await measure(first) });
    for (let k = 0; k < PLAN.count; k += 1) {
      const character = PLAN.cycle[k % PLAN.cycle.length];
      await drained();
      emit("ready-key", { k, character });
      emit("key", { k, latency: await measure(character) });
      await sleep(PLAN.pauseMs);
    }
    emit("done", {});
  };

  // ---- NFR-03, first opening
  const openLatency = async () => {
    await frame();
    await frame();
    const start = performance.now();
    submitOpen(PLAN.path);
    const seen = await paintedAfter(() => {
      const root = editorRoot();
      const line = root && root.querySelector(".cm-content .cm-line");
      if (!line) return problem() !== "" ? "refused" : false;
      return PLAN.firstLine === "" || line.textContent === PLAN.firstLine ? "shown" : false;
    }, OPEN_TIMEOUT_MS);
    if (seen === null || seen.value !== "shown") throw new Error("the note was not shown: " + problem());
    emit("open", { latency: seen.painted - start });
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
      emit("error", { reason: String(error && error.message ? error.message : error) });
      exit();
    });
})();
`;

export function instrumentationScript(plan: Plan): string {
  return SCRIPT.replace("__PLAN__", () => JSON.stringify(plan));
}
