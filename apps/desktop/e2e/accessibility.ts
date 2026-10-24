// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-49: how much of a note the accessibility tree of the editor holds, read in
// Playwright WebKit. Playwright 1.64 has no reader of the browser's own tree
// (`page.accessibility` is gone); what it has is the ARIA tree it computes in the
// page from the DOM and the styles (`ariaSnapshotJSON`), the tree its role
// locators use. Two readings of that tree, both position by position against the
// file (PROTOCOL.md section 8: a character counts when it is the one of the file
// at the same position):
//
// - the text of the tree. Playwright collapses every run of white space to one
//   space in it (`normalizeWhiteSpace` of its injected script), so this reading
//   compares the tree's text with the file's text collapsed the same way: every
//   word, in order, nothing hidden, nothing added;
// - the text of the elements the tree exposes. Each outermost node of the tree
//   that carries text is resolved to its element by its role and name (a role
//   locator, the same tree), and the text of those elements, in order, is
//   compared with the file as it is: line breaks, tabs, double and trailing
//   spaces included, which the first reading cannot see. The same reading counts
//   the text nodes whose white space the page collapses when it draws them
//   (`white-space-collapse` other than `preserve`): what the platform exposes is
//   what is drawn.
//
// The measure by the accessibility API of macOS in the built shell is CA-44's
// (work package WP-5), not this one.

import type { Page } from "@playwright/test";

/** One node of `ariaSnapshotJSON`: a static text fragment, or an element with its children. */
export type AriaNode =
  | string
  | {
      readonly role?: string;
      readonly name?: string;
      readonly text?: string;
      readonly ref?: string;
      readonly children?: readonly AriaNode[];
    };

/** The white-space rule of Playwright's ARIA tree, applied to the file for the first reading. */
export function collapseWhiteSpace(text: string): string {
  return text.replace(/[​­]/g, "").trim().replace(/\s+/g, " ");
}

/** The text fragments of a tree in document order, names left out: a label is not the note. */
export function textOfTree(nodes: readonly AriaNode[]): string {
  const fragments: string[] = [];
  const visit = (node: AriaNode): void => {
    if (typeof node === "string") {
      fragments.push(node);
      return;
    }
    if (node.text !== undefined) fragments.push(node.text);
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return collapseWhiteSpace(fragments.join(" "));
}

export interface Carrier {
  readonly role: string;
  readonly name: string;
}

/**
 * The outermost nodes of a tree that carry text, by role and name; the text of a
 * node inside one is part of its text. Text that no role node carries (a static
 * fragment at the top of the tree) has no element to resolve: it is counted apart.
 */
export function textCarriers(nodes: readonly AriaNode[]): {
  carriers: Carrier[];
  loose: number;
} {
  const carriers: Carrier[] = [];
  let loose = 0;
  const visit = (node: AriaNode): void => {
    if (typeof node === "string") {
      loose += 1;
      return;
    }
    const carries =
      node.text !== undefined || (node.children ?? []).some((child) => typeof child === "string");
    if (carries && node.role !== undefined) {
      carriers.push({ role: node.role, name: node.name ?? "" });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return { carriers, loose };
}

export interface Proportion {
  /** Characters of `expected` that `exposed` holds at the same position. */
  readonly same: number;
  readonly total: number;
  /** `same / total`, 1 for an empty `expected` only when nothing is exposed either. */
  readonly ratio: number;
  /** The first position that differs, or `null`. */
  readonly firstDifference: number | null;
}

/** PROTOCOL.md section 8: identical characters at the same position, over the characters of the file. */
export function samePosition(exposed: string, expected: string): Proportion {
  let same = 0;
  let firstDifference: number | null = null;
  for (let index = 0; index < expected.length; index += 1) {
    if (exposed.charCodeAt(index) === expected.charCodeAt(index)) same += 1;
    else firstDifference ??= index;
  }
  if (firstDifference === null && exposed.length !== expected.length) {
    firstDifference = expected.length;
  }
  const total = expected.length;
  const ratio = total === 0 ? (exposed.length === 0 ? 1 : 0) : same / total;
  return { same, total, ratio, firstDifference };
}

export interface Reading {
  readonly tree: Proportion;
  readonly elements: Proportion;
  /** Text-carrying nodes the second reading resolved. */
  readonly carriers: number;
  /** Text nodes under them, and those of them whose white space the page collapses when it draws. */
  readonly textNodes: number;
  readonly collapsed: number;
}

type Role = Parameters<Page["getByRole"]>[0];

/**
 * Both readings of the tree below `selector`, against `expected`, the text of the
 * file. The tree is Playwright's default one, the tree of `getByRole`: in it, the
 * text inside a `textbox` is its value and not a child, so the lines CodeMirror
 * draws in its content element are not read here (in Playwright's tree as in the
 * platform's, they are the value of the text box, not the note).
 */
export async function readAccessibleText(
  page: Page,
  selector: string,
  expected: string,
): Promise<Reading> {
  const host = page.locator(selector);
  const tree = (await host.ariaSnapshotJSON({ timeout: 120_000 })) as unknown as AriaNode[];
  const { carriers, loose } = textCarriers(tree);
  if (loose > 0) {
    throw new Error(`${loose} text fragment(s) of the tree have no role node to resolve`);
  }
  let raw = "";
  let textNodes = 0;
  let collapsed = 0;
  for (const carrier of carriers) {
    const element = host.getByRole(carrier.role as Role, { name: carrier.name, exact: true });
    const count = await element.count();
    if (count !== 1) {
      throw new Error(`${count} elements for ${carrier.role} "${carrier.name}", 1 expected`);
    }
    // The text, and whether the page draws its white space as written: the
    // platform's tree is built from what is drawn, so a collapsed run of spaces
    // there is a collapsed run in what assistive technologies read.
    const found = await element.evaluate((root) => {
      const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let nodes = 0;
      let collapsing = 0;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        nodes += 1;
        const parent = node.parentElement;
        const style = parent === null ? null : getComputedStyle(parent);
        if (style === null || style.getPropertyValue("white-space-collapse") !== "preserve") {
          collapsing += 1;
        }
      }
      return { text: root.textContent ?? "", nodes, collapsing };
    });
    raw += found.text;
    textNodes += found.nodes;
    collapsed += found.collapsing;
  }
  return {
    tree: samePosition(textOfTree(tree), collapseWhiteSpace(expected)),
    elements: samePosition(raw, expected),
    carriers: carriers.length,
    textNodes,
    collapsed,
  };
}

export function percent(proportion: Proportion): string {
  const first = proportion.firstDifference === null ? "none" : String(proportion.firstDifference);
  return `${proportion.same}/${proportion.total} (${(proportion.ratio * 100).toFixed(4)} %, first difference ${first})`;
}
