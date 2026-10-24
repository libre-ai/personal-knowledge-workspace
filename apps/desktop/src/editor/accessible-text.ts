// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// EF-P04-11: the whole text of the note in the accessibility tree. CodeMirror
// draws the visible lines only (on the 1 MiB note of CR-10k, a few dozen lines of
// 34 589), and the platform exposes what is drawn: the measure `ADR-0057:64`
// records found 0,54 % of a 1 MiB note exposed. This extension keeps, next to the
// editor, a copy of the document that is drawn nowhere and laid out as written:
//
// - one element of role `document`, named `ACCESSIBLE_TEXT_LABEL`, out of sight
//   (the usual one-pixel clip of a text for screen readers only) but neither
//   `display: none`, nor `visibility: hidden`, nor `aria-hidden`, which would take
//   it out of the tree;
// - `white-space: pre`, so that double and trailing spaces, tabs and empty lines
//   are in the tree as they are in the note;
// - its text in blocks of whole lines (`text-chunks.ts`), so that an edit rewrites
//   the blocks it changed and no other.
//
// The copy is read-only and outside the content element: CodeMirror reads its
// own content element only, so nothing typed or changed here can reach the
// document, and the copy writes nothing (AT-01). It does not take the focus.
//
// Where the copy sits for the measure of CA-44 (work package WP-5): inside the
// shadow root of the editor's host, a child of `.cm-editor`, after the scroller.

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { CHUNK_LINES, type Chunk, TextChunks } from "./text-chunks";

/** The accessible name of the copy, for the tree and for whoever reads it. */
export const ACCESSIBLE_TEXT_LABEL = "Note text, whole note, read only";

/** The class of the copy; `styles.ts` takes it out of sight without taking it out of the tree. */
export const ACCESSIBLE_TEXT_CLASS = "cm-accessible-text";

class AccessibleText {
  readonly #root: HTMLElement;
  readonly #chunks: TextChunks;
  readonly #blocks = new Map<number, HTMLElement>();

  constructor(view: EditorView) {
    const owner = view.dom.ownerDocument;
    this.#root = owner.createElement("div");
    this.#root.className = ACCESSIBLE_TEXT_CLASS;
    this.#root.setAttribute("role", "document");
    this.#root.setAttribute("aria-label", ACCESSIBLE_TEXT_LABEL);
    this.#chunks = new TextChunks(view.state.doc, CHUNK_LINES);
    for (const chunk of this.#chunks.chunks) this.#root.append(this.#block(chunk));
    view.dom.append(this.#root);
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged) return;
    const { chunks, changed, removed } = this.#chunks.update(update.state.doc, update.changes);
    for (const key of removed) {
      this.#blocks.get(key)?.remove();
      this.#blocks.delete(key);
    }
    // Blocks are put in document order: a new one goes after the block before it.
    let previous: HTMLElement | null = null;
    for (const chunk of chunks) {
      let block = this.#blocks.get(chunk.key);
      if (block === undefined) {
        block = this.#block(chunk);
        if (previous === null) this.#root.prepend(block);
        else previous.after(block);
      } else if (changed.has(chunk.key)) {
        this.#write(block, chunk.text);
      }
      previous = block;
    }
  }

  destroy(): void {
    this.#root.remove();
    this.#blocks.clear();
  }

  #block(chunk: Chunk): HTMLElement {
    const block = this.#root.ownerDocument.createElement("div");
    this.#write(block, chunk.text);
    this.#blocks.set(chunk.key, block);
    return block;
  }

  /** The text node is kept when there is one: the tree updates it rather than making a new one. */
  #write(block: HTMLElement, text: string): void {
    const node = block.firstChild;
    if (node instanceof Text && block.childNodes.length === 1) node.data = text;
    else block.textContent = text;
  }
}

/** The whole note in the accessibility tree, for the editor it is given to. */
export function accessibleText(): Extension {
  return ViewPlugin.fromClass(AccessibleText);
}
