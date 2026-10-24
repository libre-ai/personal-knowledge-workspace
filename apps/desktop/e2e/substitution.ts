// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The red vector of CA-41: an extension that rewrites what is typed, as a
// word processor does (typographic quotes, dashes, ellipsis). It is never part
// of the application; the page `substituting.html` adds it to the editor so that
// the run can show its instrument sees a substitution. If the test that types
// the same sequence there still found the typed bytes on disk, the test that
// the editor writes exactly the typed bytes would prove nothing.
//
// It is a transaction filter, so it acts whatever path the keystroke took into
// the document (the editor's own `beforeinput` handler included).

import { EditorState, type Extension } from "@codemirror/state";

export function smartTyping(): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !transaction.isUserEvent("input.type")) return transaction;
    let from = 0;
    let to = 0;
    let text = "";
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      from = fromA;
      to = toA;
      text = inserted.toString();
    });
    const before = transaction.startState.doc.sliceString(Math.max(0, from - 2), from);
    let replaceFrom = from;
    let insert = text;
    if (text === '"') {
      insert = before === "" || /\s$/.test(before) ? "“" : "”";
    } else if (text === "'") {
      insert = "’";
    } else if (text === "-" && before.endsWith("-")) {
      replaceFrom = from - 1;
      insert = "–";
    } else if (text === "." && before === "..") {
      replaceFrom = from - 2;
      insert = "…";
    } else {
      return transaction;
    }
    return [
      {
        changes: { from: replaceFrom, to, insert },
        selection: { anchor: replaceFrom + insert.length },
        userEvent: "input.type",
      },
    ];
  });
}
