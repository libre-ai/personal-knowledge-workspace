// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// CA-41: the editor changes no character the user did not type. This module is
// the whole list of what CodeMirror is given, and the list is short on purpose:
//
// - no `defaultKeymap`: its Enter is `insertNewlineAndIndent`, which copies the
//   indentation of the previous line (characters nobody typed) and deletes a
//   whitespace-only line before the cursor; its Backspace removes a whole
//   indent unit. Enter is a plain line break, Backspace and Delete stay native;
// - no `@codemirror/autocomplete` (closing brackets, completions) and no
//   `@codemirror/language` (indent on input): they are outside the closed list
//   of the front (`tests/bridge/front-rules.ts`);
// - one line separator, "\n": CodeMirror splits a document on CRLF and lone CR
//   by default and joins it back with "\n", which would rewrite a CRLF note on
//   its first save. With this facet a "\r" stays a character of its line;
// - no substitution of the platform either: the content element carries
//   `spellcheck="false"`, `autocorrect="off"` and `autocapitalize="off"`, which
//   is what WebKit reads to leave smart quotes, dashes and corrections off.
//   Whether the system honours them in the WKWebView of the shell is not
//   measured by the Playwright run (see the e2e report in the pull request).

import { history, historyKeymap, insertNewline } from "@codemirror/commands";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

/**
 * The characters of a keystroke go from the event to the document untouched.
 *
 * Left to the browser, a space typed after a space becomes U+00A0 in a
 * contenteditable (WebKit does it, measured by the first run of the e2e test: two
 * double spaces wrote 2 more bytes), and CodeMirror reads that U+00A0 back from
 * the DOM. `beforeinput` of type `insertText` carries what the user typed in
 * `data`, a plain space included: the editor inserts that, itself, and cancels the
 * browser's own edit. A U+00A0 the user really typed (Option+Space) arrives as
 * U+00A0 in `data` and is inserted as such. A composition (IME) is left to
 * CodeMirror, which handles it. A replacement the platform proposes
 * (`insertReplacementText`: autocorrection, a spelling suggestion) is cancelled:
 * nobody typed it.
 */
const keystrokes = EditorView.domEventHandlers({
  beforeinput(event, view) {
    if (event.isComposing) return false;
    if (event.inputType === "insertReplacementText") {
      event.preventDefault();
      return true;
    }
    if (event.inputType !== "insertText" || typeof event.data !== "string") return false;
    event.preventDefault();
    view.dispatch(view.state.replaceSelection(event.data), {
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  },
});

export function typedTextOnly(): Extension {
  return [
    EditorState.lineSeparator.of("\n"),
    keystrokes,
    history(),
    keymap.of([{ key: "Enter", run: insertNewline, shift: insertNewline }, ...historyKeymap]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
      "aria-label": "Note text",
    }),
  ];
}
