// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The live preview of CA-41 changes attributes and nothing else: from the
// attribute tree that `render_preview` returns (the shell parsed the note; the
// front parses nothing, CA-40), this module lists the ranges of the document to
// mark and the attributes each mark carries. A mark wraps text that is already
// in the document; it adds no text, no widget and no element that would be
// interpreted (no `href`, no `src`, no event handler, no `style`): a destination
// is carried as inert data (`data-md-url`), and one the shell blocked says so.

import type { NodeKind, PreviewNode } from "../bridge";

export interface Mark {
  readonly from: number;
  readonly to: number;
  readonly className: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** The kinds the shell can emit (`contract.ts`); a kind outside it is dropped, not guessed. */
const KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "document",
  "paragraph",
  "heading",
  "block_quote",
  "code_block",
  "list",
  "list_item",
  "emphasis",
  "strong",
  "strikethrough",
  "code",
  "link",
  "wiki_link",
  "image",
  "rule",
  "html",
  "frontmatter",
  "table",
  "table_head",
  "table_row",
  "table_cell",
  "other",
]);

function attributesOf(node: PreviewNode): Record<string, string> {
  const attributes: Record<string, string> = { "data-md-kind": node.kind };
  if (node.level !== undefined) attributes["data-md-level"] = String(node.level);
  if (node.language !== undefined) attributes["data-md-language"] = node.language;
  if (node.ordered !== undefined) attributes["data-md-ordered"] = String(node.ordered);
  if (node.start !== undefined) attributes["data-md-start"] = String(node.start);
  if (node.checked !== undefined) attributes["data-md-checked"] = String(node.checked);
  if (node.url !== undefined) attributes["data-md-url"] = node.url;
  if (node.target !== undefined) attributes["data-md-target"] = node.target;
  if (node.blocked === true) attributes["data-md-blocked"] = "true";
  return attributes;
}

/**
 * The marks of `tree` for a document of `length` UTF-16 units, outermost first.
 * A node whose range is empty, reversed, outside the document or of an unknown
 * kind is dropped: the tree may be older than the text by the time it arrives.
 */
export function marksOf(tree: PreviewNode, length: number): Mark[] {
  const marks: Mark[] = [];
  const visit = (node: PreviewNode): void => {
    const inside =
      Number.isInteger(node.from) &&
      Number.isInteger(node.to) &&
      node.from >= 0 &&
      node.from < node.to &&
      node.to <= length;
    if (node.kind !== "document" && inside && KINDS.has(node.kind)) {
      const level =
        node.kind === "heading" && node.level !== undefined ? ` cm-md-h${node.level}` : "";
      marks.push({
        from: node.from,
        to: node.to,
        className: `cm-md cm-md-${node.kind}${level}`,
        attributes: attributesOf(node),
      });
    }
    for (const child of node.children) visit(child);
  };
  visit(tree);
  return marks.sort((a, b) => a.from - b.from || b.to - a.to);
}
