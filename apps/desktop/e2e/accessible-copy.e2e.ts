// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-49, the DOM side of the accessible copy (`src/editor/accessible-text.ts`):
// in Playwright WebKit, the editor's blocks are merged, removed, cut again and
// emptied by edits that typing in the application cannot reach, and after each
// one the copy is exactly the document: the blocks joined in page order, and the
// two readings of the tree (`accessibility.ts`) with no difference at any
// position. A block left behind, put in the wrong place or not rewritten shows
// as a difference. The page is `accessible-copy.html` (`accessible-copy.ts`).

import { expect, type Page, test } from "@playwright/test";
import { percent, readAccessibleText } from "./accessibility";
import type { AccessibleCopyPage } from "./accessible-copy";

type Change = Parameters<AccessibleCopyPage["change"]>[0];

/** Lines of words, tabs, double and trailing spaces: the white space must reach the tree as it is. */
function lines(count: number, tag: string): string {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const words = "mot ".repeat(index % 4);
    out.push(`${tag} ${index}\t${words} fin${index % 3 === 0 ? "  " : ""}`);
  }
  return `${out.join("\n")}\n`;
}

async function mount(page: Page, text: string): Promise<void> {
  await page.goto("/accessible-copy.html");
  await page.evaluate(
    (content) =>
      (window as unknown as { accessibleCopy: AccessibleCopyPage }).accessibleCopy.mount(content),
    text,
  );
}

async function change(page: Page, changes: Change): Promise<void> {
  await page.evaluate(
    (spec) =>
      (window as unknown as { accessibleCopy: AccessibleCopyPage }).accessibleCopy.change(spec),
    changes,
  );
}

async function blocks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { accessibleCopy: AccessibleCopyPage }).accessibleCopy.blocks(),
  );
}

/** Offsets where the blocks start, from the page: each block starts where the one before ends. */
async function starts(page: Page): Promise<number[]> {
  const texts = await blocks(page);
  const out: number[] = [];
  let at = 0;
  for (const text of texts) {
    out.push(at);
    at += text.length;
  }
  return out;
}

/** The copy is the document: joined blocks, and both readings of the tree, at every position. */
async function expectCopy(page: Page, step: string): Promise<number> {
  const doc = await page.evaluate(() =>
    (window as unknown as { accessibleCopy: AccessibleCopyPage }).accessibleCopy.documentText(),
  );
  const texts = await blocks(page);
  const reading = await readAccessibleText(page, "#editor", doc);
  console.log(
    `${step}: ${doc.length} characters, ${texts.length} blocks; ` +
      `tree text ${percent(reading.tree)}; element text ${percent(reading.elements)}; ` +
      `white space collapsed in ${reading.collapsed} of ${reading.textNodes} text nodes`,
  );
  expect({ step, joined: texts.join("") === doc }).toEqual({ step, joined: true });
  expect({ step, first: reading.tree.firstDifference }).toEqual({ step, first: null });
  expect({ step, first: reading.elements.firstDifference }).toEqual({ step, first: null });
  expect(reading.tree.ratio).toBe(1);
  expect(reading.elements.ratio).toBe(1);
  expect(reading.collapsed).toBe(0);
  return texts.length;
}

function at(list: readonly number[], index: number): number {
  const value = list[index < 0 ? list.length + index : index];
  if (value === undefined) throw new Error(`no block ${index}`);
  return value;
}

test.describe("CA-49: the blocks of the accessible copy follow every edit", () => {
  test("blocks merged, removed, cut again, emptied and filled stay the document", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // 1 300 lines and a final line break: blocks of 256 lines, the last one taking the rest.
    await mount(page, lines(1_300, "ligne"));
    const initial = await expectCopy(page, "mounted");
    expect(initial).toBe(5);

    // The line break that ends the first block is deleted: its last line joins the
    // second block's first line, and the boundary moves back. Two blocks rewritten.
    let s = await starts(page);
    await change(page, [{ from: at(s, 1) - 1, to: at(s, 1) }]);
    expect(await expectCopy(page, "line break deleted at a boundary")).toBe(initial);

    // A whole block in the middle is deleted: its element must go.
    s = await starts(page);
    await change(page, [{ from: at(s, 2), to: at(s, 3) }]);
    expect(await expectCopy(page, "middle block deleted")).toBe(initial - 1);

    // 700 lines pasted inside the second block: past 512 lines, it is cut again, and
    // the new blocks go right after it, in the middle of the copy.
    s = await starts(page);
    await change(page, [{ from: at(s, 1) + 3, insert: lines(700, "collé") }]);
    expect(await expectCopy(page, "block cut again past 512 lines")).toBe(initial + 1);

    // A paste of 5 000 lines in the middle of the document, mid-line.
    const length = (await blocks(page)).join("").length;
    await change(page, [{ from: Math.floor(length / 2), insert: lines(5_000, "masse") }]);
    const afterPaste = await expectCopy(page, "massive paste in the middle");
    expect(afterPaste).toBeGreaterThan(initial + 15);

    // The last block is deleted: nothing of it may stay at the end of the copy.
    s = await starts(page);
    const total = (await blocks(page)).join("").length;
    await change(page, [{ from: at(s, -1), to: total }]);
    expect(await expectCopy(page, "last block deleted")).toBe(afterPaste - 1);

    // The document is emptied, then typed into again.
    const all = (await blocks(page)).join("").length;
    await change(page, [{ from: 0, to: all }]);
    expect(await expectCopy(page, "document emptied")).toBe(1);
    await change(page, [{ from: 0, insert: "x" }]);
    expect(await expectCopy(page, "typed again")).toBe(1);
  });
});
