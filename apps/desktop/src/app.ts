// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The window of the shell: choose the folder of the notes (a native dialog the
// front cannot drive, CA-47), name a note of it, edit it. The page is built with
// `createElement` and `textContent`; no string of the shell or of a note is ever
// parsed as markup.

import { type Bridge, BridgeFailure, BridgeRefusal, type Listen, onVaultChanged } from "./bridge";
import { type NoteEditor, type OpenOptions, openNote } from "./editor/note-editor";
import { NotUtf8, type SaveState } from "./editor/note-session";

const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  "vault.not_open": "No folder is chosen yet.",
  "vault.already_open": "A folder is already chosen for this session.",
  "vault.invalid_vault": "That folder cannot be used as a vault.",
  "vault.invalid_path": "That note name is not allowed.",
  "vault.not_found": "That note does not exist.",
  "vault.too_large": "That note is too large.",
  "vault.io": "The folder could not be read or written.",
};

const SAVE_TEXT: Readonly<Record<SaveState, string>> = {
  idle: "Ready",
  dirty: "Unsaved changes",
  saving: "Saving",
  saved: "Saved",
  conflict: "The note changed elsewhere: saving is stopped, nothing was overwritten",
  refused: "The text cannot be saved as UTF-8: saving is stopped",
  failed: "Saving failed: it is retried at the next change",
};

function explain(failure: unknown): string {
  if (failure instanceof NotUtf8) return "That note is not UTF-8 text; it is not opened.";
  if (failure instanceof BridgeRefusal) {
    return REFUSAL_TEXT[failure.code] ?? "The shell refused the request.";
  }
  if (failure instanceof BridgeFailure) return "The shell did not answer as expected.";
  return "Something went wrong.";
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
  if (text !== undefined) created.textContent = text;
  return created;
}

export interface AppOptions extends OpenOptions {
  /** The default note name offered after the folder is chosen. */
  readonly defaultNote?: string;
}

export function mountApp(
  root: HTMLElement,
  bridge: Bridge,
  listen: Listen,
  options: AppOptions = {},
): void {
  const choose = element("button", { type: "button", id: "choose-vault" }, "Choose notes folder");
  const vaultStatus = element("span", { id: "vault-status", role: "status" });
  const header = element("header");
  header.append(choose, vaultStatus);

  const noteName = element("input", {
    id: "note-path",
    type: "text",
    name: "note",
    autocomplete: "off",
    required: "",
    value: options.defaultNote ?? "inbox.md",
  });
  const label = element("label", { for: "note-path" }, "Note ");
  label.append(noteName);
  const open = element("button", { type: "submit", id: "open-note" }, "Open");
  const form = element("form", { id: "open-form", hidden: "" });
  form.append(label, open);

  const host = element("div", { id: "editor" });
  const saveStatus = element("p", { id: "save-state", role: "status" }, "");
  const problem = element("p", { id: "problem", role: "alert" }, "");
  root.replaceChildren(header, form, host, saveStatus, problem);

  let current: NoteEditor | null = null;
  let heard: ((change: { path: string; revision: string }) => void) | null = null;
  const listening = onVaultChanged(listen, (change) => heard?.(change)).catch(() => {
    problem.textContent = "The shell does not report changes of the notes.";
  });

  choose.addEventListener("click", () => {
    choose.disabled = true;
    problem.textContent = "";
    const chosen = (): void => {
      vaultStatus.textContent = "Folder chosen";
      form.hidden = false;
      noteName.focus();
    };
    bridge.chooseVault().then(chosen, (failure: unknown) => {
      // The root lives as long as the process, not the page: a page that is loaded
      // again finds it already chosen, and goes on with it.
      if (failure instanceof BridgeRefusal && failure.code === "vault.already_open") {
        chosen();
        return;
      }
      // A dismissed dialog or a refused folder leaves the choice open.
      problem.textContent = explain(failure);
      choose.disabled = false;
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    problem.textContent = "";
    const path = noteName.value;
    current?.destroy();
    current = null;
    host.replaceChildren();
    saveStatus.textContent = "";
    saveStatus.removeAttribute("data-state");
    openNote(host, bridge, path, options).then(
      (editor) => {
        current = editor;
        const show = (state: SaveState): void => {
          saveStatus.textContent = SAVE_TEXT[state];
          saveStatus.setAttribute("data-state", state);
        };
        show(editor.session.state);
        editor.session.onState(show);
        heard = (change) => editor.session.noteChanged(change);
        editor.view.focus();
      },
      (failure: unknown) => {
        problem.textContent = explain(failure);
      },
    );
  });

  void listening;
}
