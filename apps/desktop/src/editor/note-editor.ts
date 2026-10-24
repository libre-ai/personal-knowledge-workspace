// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// A CodeMirror 6 editor on one note of the vault (EF-P04-10): the note is read
// and written through the bridge, the live preview comes from `render_preview`,
// and the only extensions are those of `typed-text.ts`. The text of the buffer
// is what the user typed and nothing else (CA-41). The whole text of the note is
// in the accessibility tree, not only the lines on screen (`accessible-text.ts`,
// CA-49).

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { Bridge } from "../bridge";
import { accessibleText } from "./accessible-text";
import { NoteSession, type SessionOptions } from "./note-session";
import { livePreview } from "./preview";
import { adoptEditorStyles } from "./styles";
import { typedTextOnly } from "./typed-text";

export interface OpenOptions extends SessionOptions {
  readonly previewDelayMs?: number;
  /**
   * Extensions added after the ones of the editor. The application passes none;
   * the e2e run passes a text-substituting extension to prove that its check
   * sees a substitution (the red vector of CA-41).
   */
  readonly extensions?: readonly Extension[];
}

export interface NoteEditor {
  readonly view: EditorView;
  readonly session: NoteSession;
  destroy(): void;
}

/**
 * Opens `path` in an editor mounted on `parent`, inside a shadow root of its own
 * so that its styles can be adopted rather than injected (`styles.ts`: the CSP
 * refuses an inline `<style>`). A note that does not exist opens empty and is
 * created by the first save; a note that is not UTF-8 rejects with `NotUtf8` and
 * no editor is created.
 */
export async function openNote(
  parent: HTMLElement,
  bridge: Bridge,
  path: string,
  options: OpenOptions = {},
): Promise<NoteEditor> {
  const session = new NoteSession(bridge, path, options);
  const { text } = await session.load();
  const root = parent.shadowRoot ?? parent.attachShadow({ mode: "open" });
  root.replaceChildren();
  adoptEditorStyles(root);
  const mount = document.createElement("div");
  root.append(mount);
  const view = new EditorView({
    parent: mount,
    root,
    state: EditorState.create({
      doc: text,
      extensions: [
        typedTextOnly(),
        livePreview(bridge, options.previewDelayMs),
        accessibleText(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) session.edit(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          blur: () => {
            void session.flush();
          },
        }),
        ...(options.extensions ?? []),
      ],
    }),
  });
  return {
    view,
    session,
    destroy: () => {
      void session.flush();
      view.destroy();
    },
  };
}
