// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// A test page for the DOM side of `accessible-text.ts` (CA-49): the editor of
// the application, its typed-text rules and its accessible copy, on a document
// the test gives and changes through CodeMirror's own transactions. No note, no
// bridge: what is under test is how the copy's blocks are made, removed, ordered
// and rewritten in the page, edit after edit, which typing in the application
// cannot reach (it edits where the caret is, in the lines on screen).
//
// The page `accessible-copy.html` is bundled by `stage.ts`; nothing of it ships.

import { type ChangeSpec, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { accessibleText } from "../src/editor/accessible-text";
import { adoptEditorStyles } from "../src/editor/styles";
import { typedTextOnly } from "../src/editor/typed-text";

export interface AccessibleCopyPage {
  /** Mounts the editor on `text` in `#editor`, replacing any editor before it. */
  mount(text: string): void;
  /** Applies `changes`, in the coordinates of the current document, as one transaction. */
  change(changes: readonly { from: number; to?: number; insert?: string }[]): void;
  /** The document as CodeMirror holds it. */
  documentText(): string;
  /** The text of each block of the copy, in page order. */
  blocks(): string[];
}

let view: EditorView | null = null;

const page: AccessibleCopyPage = {
  mount(text) {
    view?.destroy();
    const host = document.getElementById("editor");
    if (host === null) throw new Error("the page has no #editor element");
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.replaceChildren();
    adoptEditorStyles(root);
    const mount = document.createElement("div");
    root.append(mount);
    view = new EditorView({
      parent: mount,
      root,
      state: EditorState.create({ doc: text, extensions: [typedTextOnly(), accessibleText()] }),
    });
  },
  change(changes) {
    if (view === null) throw new Error("no editor is mounted");
    view.dispatch({ changes: changes as ChangeSpec });
  },
  documentText() {
    if (view === null) throw new Error("no editor is mounted");
    return view.state.doc.toString();
  },
  blocks() {
    const copy = document.getElementById("editor")?.shadowRoot?.querySelector('[role="document"]');
    if (copy === null || copy === undefined) return [];
    return Array.from(copy.children, (block) => block.textContent ?? "");
  },
};

(window as unknown as { accessibleCopy: AccessibleCopyPage }).accessibleCopy = page;
