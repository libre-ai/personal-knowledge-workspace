// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The live preview of CA-41 as a CodeMirror extension. After the text settles
// it asks the shell for the attribute tree (`render_preview`, the UTF-8 bytes of
// the buffer) and marks the ranges the tree names. The document is never an
// input of a change here: the only transaction this extension dispatches
// carries a decoration effect, and the decorations are mapped through the edits
// that happen while a tree is in flight, so a mark never drifts onto other text.

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";

import type { Bridge } from "../bridge";
import { type Mark, marksOf } from "./preview-marks";

const setPreview = StateEffect.define<DecorationSet>();

const previewMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setPreview)) next = effect.value;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decorationsOf(marks: readonly Mark[]): DecorationSet {
  return Decoration.set(
    marks.map((mark) =>
      Decoration.mark({ class: mark.className, attributes: { ...mark.attributes } }).range(
        mark.from,
        mark.to,
      ),
    ),
    true,
  );
}

export function livePreview(bridge: Pick<Bridge, "renderPreview">, delayMs = 120): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;

      constructor(private readonly view: EditorView) {
        this.schedule();
      }

      update(update: { docChanged: boolean }): void {
        if (update.docChanged) this.schedule();
      }

      destroy(): void {
        clearTimeout(this.timer);
      }

      private schedule(): void {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.render(), delayMs);
      }

      private async render(): Promise<void> {
        const document = this.view.state.doc;
        const text = document.toString();
        // A buffer with a lone surrogate has no UTF-8 form: the shell cannot read it.
        if (!text.isWellFormed()) return;
        let tree: Awaited<ReturnType<Bridge["renderPreview"]>>;
        try {
          tree = await bridge.renderPreview(new TextEncoder().encode(text));
        } catch {
          return; // the preview is an aid: a refusal leaves the previous marks mapped
        }
        // The text moved on while the tree was in flight: the next render replaces it.
        if (this.view.state.doc !== document) return;
        this.view.dispatch({
          effects: setPreview.of(decorationsOf(marksOf(tree, document.length))),
        });
      }
    },
  );
  return [previewMarks, plugin];
}
