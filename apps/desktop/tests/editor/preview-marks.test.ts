// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-41, the live preview changes attributes only: the marks computed from the
// attribute tree of `render_preview` name ranges of the text and attributes, and
// carry nothing a browser would interpret or fetch.

import { describe, expect, test } from "bun:test";

import type { PreviewNode } from "../../src/bridge";
import { marksOf } from "../../src/editor/preview-marks";

function node(
  kind: PreviewNode["kind"],
  from: number,
  to: number,
  extra: Partial<PreviewNode> = {},
) {
  return { kind, from, to, children: [], ...extra } satisfies PreviewNode;
}

describe("marksOf", () => {
  const tree: PreviewNode = {
    ...node("document", 0, 40),
    children: [
      { ...node("heading", 0, 8, { level: 2 }), children: [node("emphasis", 3, 7)] },
      node("code_block", 9, 20, { language: "rust" }),
      {
        ...node("paragraph", 21, 40),
        children: [node("link", 22, 38, { url: "https://example.test/" })],
      },
    ],
  };

  test("lists each node of the tree outermost first, with class and data attributes", () => {
    const marks = marksOf(tree, 40);
    expect(marks.map((mark) => [mark.from, mark.to, mark.attributes["data-md-kind"]])).toEqual([
      [0, 8, "heading"],
      [3, 7, "emphasis"],
      [9, 20, "code_block"],
      [21, 40, "paragraph"],
      [22, 38, "link"],
    ]);
    expect(marks[0]?.className).toBe("cm-md cm-md-heading cm-md-h2");
    expect(marks[0]?.attributes["data-md-level"]).toBe("2");
    expect(marks[2]?.attributes["data-md-language"]).toBe("rust");
    expect(marks[4]?.attributes["data-md-url"]).toBe("https://example.test/");
  });

  test("a mark carries no attribute a browser would act on", () => {
    const hostile: PreviewNode = {
      ...node("document", 0, 30),
      children: [
        node("link", 0, 10, { url: "javascript:alert(1)", blocked: true }),
        node("image", 11, 20, { url: "https://tracker.example.test/p.gif" }),
        node("html", 21, 30),
      ],
    };
    for (const mark of marksOf(hostile, 30)) {
      for (const name of Object.keys(mark.attributes)) {
        expect(name.startsWith("data-md-"), name).toBe(true);
      }
      expect(mark.className).toMatch(/^cm-md cm-md-[a-z_]+( cm-md-h\d)?$/);
    }
    const blocked = marksOf(hostile, 30)[0];
    expect(blocked?.attributes["data-md-blocked"]).toBe("true");
  });

  test("a range that is empty, reversed, fractional, or outside the text is dropped", () => {
    const stale: PreviewNode = {
      ...node("document", 0, 100),
      children: [
        node("paragraph", 5, 5),
        node("paragraph", 8, 3),
        node("paragraph", -1, 4),
        node("paragraph", 0.5, 4),
        node("paragraph", 2, 31),
        node("paragraph", 2, 30),
      ],
    };
    expect(marksOf(stale, 30).map((mark) => [mark.from, mark.to])).toEqual([[2, 30]]);
  });

  test("a kind the contract does not list is dropped, not guessed", () => {
    const foreign = {
      ...node("document", 0, 10),
      children: [{ kind: "script", from: 0, to: 5, children: [] }],
    } as unknown as PreviewNode;
    expect(marksOf(foreign, 10)).toEqual([]);
  });

  test("the document node itself is not a mark", () => {
    expect(marksOf(node("document", 0, 10), 10)).toEqual([]);
  });
});
