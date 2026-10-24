// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The red vector of CA-49: the editor as it was before `accessible-text.ts`,
// which exposes its label and nothing of the note (`typed-text.ts`, the
// `aria-label` of the content element). It is never part of the application; the
// page `without-accessible-text.html` mounts it so that the run can show its
// instrument sees a note missing from the tree. If the test that reads the tree of
// the application read the same note here and still found it whole, it would
// prove nothing.
//
// The note is read through the bridge as the application reads it; the editor is
// the application's, its accessible copy left out.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { BridgeRefusal } from "../src/bridge";
import { tauriBridge } from "../src/bridge/transport";
import { NoteSession } from "../src/editor/note-session";
import { adoptEditorStyles } from "../src/editor/styles";
import { typedTextOnly } from "../src/editor/typed-text";

async function openWithoutAccessibleText(path: string): Promise<void> {
  const bridge = tauriBridge();
  try {
    await bridge.chooseVault();
  } catch (failure) {
    // The root lives as long as the harness, not the page (`src/app.ts`).
    if (!(failure instanceof BridgeRefusal && failure.code === "vault.already_open")) throw failure;
  }
  const { text } = await new NoteSession(bridge, path).load();
  const host = document.getElementById("editor");
  if (host === null) throw new Error("the page has no #editor element");
  const root = host.attachShadow({ mode: "open" });
  adoptEditorStyles(root);
  const mount = document.createElement("div");
  root.append(mount);
  new EditorView({
    parent: mount,
    root,
    state: EditorState.create({ doc: text, extensions: [typedTextOnly()] }),
  });
  document.getElementById("state")?.setAttribute("data-state", "open");
}

(
  window as unknown as { openWithoutAccessibleText: typeof openWithoutAccessibleText }
).openWithoutAccessibleText = openWithoutAccessibleText;
