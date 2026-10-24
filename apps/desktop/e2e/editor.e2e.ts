// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-41, in Playwright WebKit: the production front, in the page, edits a note
// of a vault through the bridge of the shell (the harness relays the IPC to the
// real bridge, ACL, vault core and disk; see `src-tauri/src/bin/e2e_harness.rs`).
// Each test names the file it works on: the vault is shared by the run.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import type { IpcLogEntry } from "./shim";
import { installTauriShim } from "./shim";

const VAULT = process.env.P04_E2E_VAULT;
if (VAULT === undefined) throw new Error("P04_E2E_VAULT is not set: playwright.config.ts sets it");

/**
 * What the user types: straight quotes, two hyphens, three dots, a URL, two
 * spaces, a misspelled word, an address, an apostrophe, a fraction, an arrow and
 * a copyright sign spelt `(c)`, over two lines. Every one is something a word
 * processor or a platform text service rewrites.
 */
const TYPED_LINES = [
  `He said "hi" -- wait... see https://example.test/a?b=1&c=2  and  teh mispelled word, jane.doe@example.test`,
  `It's 1/2 -> done (c) café`,
  "",
];
const TYPED = TYPED_LINES.join("\n");

function notePath(title: string): string {
  return `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`;
}

function onDisk(path: string): Buffer {
  return readFileSync(join(VAULT as string, path));
}

async function open(page: Page, note: string, entry = "/"): Promise<void> {
  await page.addInitScript(installTauriShim);
  await page.goto(entry);
  await page.locator("#choose-vault").click();
  await expect(page.locator("#vault-status")).toHaveText("Folder chosen");
  await page.locator("#note-path").fill(note);
  await page.locator("#open-note").click();
  await expect(page.locator("#save-state")).toHaveAttribute("data-state", /./);
  await expect(page.locator(".cm-content")).toBeVisible();
}

async function type(page: Page, lines: readonly string[]): Promise<void> {
  await page.locator(".cm-content").click();
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press("Enter");
    if (line !== "") await page.keyboard.type(line);
  }
}

/** Puts the caret after the last character of the document, with the platform's own key. */
async function caretToEnd(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
}

async function saved(page: Page): Promise<void> {
  await expect(page.locator("#save-state")).toHaveAttribute("data-state", "saved");
}

/** The text of the editor, line by line: what the document holds, not what is drawn. */
async function documentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The editor lives in the shadow root of #editor (its styles are adopted, not injected).
    const root = document.querySelector("#editor")?.shadowRoot;
    if (!root) throw new Error("the editor has no shadow root");
    return Array.from(root.querySelectorAll(".cm-content .cm-line"))
      .map((line) => line.textContent ?? "")
      .join("\n");
  });
}

async function ipcLog(page: Page): Promise<IpcLogEntry[]> {
  return page.evaluate(() => (window as unknown as { __ipcLog: IpcLogEntry[] }).__ipcLog.slice());
}

test.describe("CA-41: the editor changes no character that was not typed", () => {
  test("the editor writes exactly the typed bytes", async ({ page }) => {
    const note = notePath("typed bytes");
    await open(page, note);
    await type(page, TYPED_LINES);
    await saved(page);

    // What the shell wrote, byte for byte.
    const expected = Buffer.from(TYPED, "utf8");
    const written = onDisk(note);
    console.log(`typed ${expected.length} bytes, ${written.length} bytes on disk`);
    expect(written.equals(expected)).toBe(true);

    // What write_note was given, byte for byte, and what the editor holds.
    const writes = (await ipcLog(page)).filter((entry) => entry.command === "write_note");
    expect(writes.length).toBeGreaterThan(0);
    const last = writes[writes.length - 1];
    expect(last?.bytes).toEqual([...expected]);
    expect(last?.headers["x-vault-path"]).toBe(encodeURIComponent(note));
    expect(await documentText(page)).toBe(TYPED);

    // The page ran under the CSP of the shell without a violation.
    expect(
      await page.evaluate(
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
      ),
    ).toEqual([]);
  });

  test("the editor attributes tell the platform to leave the text alone", async ({ page }) => {
    await open(page, notePath("attributes"));
    const attributes = await page.locator(".cm-content").evaluate((element) => ({
      spellcheck: element.getAttribute("spellcheck"),
      autocorrect: element.getAttribute("autocorrect"),
      autocapitalize: element.getAttribute("autocapitalize"),
      translate: element.getAttribute("translate"),
    }));
    expect(attributes).toEqual({
      spellcheck: "false",
      autocorrect: "off",
      autocapitalize: "off",
      translate: "no",
    });
  });

  test("a note with CRLF, a BOM and decomposed accents keeps its bytes when one character is typed", async ({
    page,
  }) => {
    const note = notePath("crlf bom nfd");
    const original = Buffer.from("﻿café été\r\nline two\r\n\tindented  \r\nlone\rcr\n", "utf8");
    mkdirSync(dirname(join(VAULT as string, note)), { recursive: true });
    writeFileSync(join(VAULT as string, note), original);

    await open(page, note);
    await page.locator(".cm-content").click();
    await caretToEnd(page);
    await page.keyboard.type("X");
    await saved(page);

    const expected = Buffer.concat([original, Buffer.from("X")]);
    expect(onDisk(note).equals(expected)).toBe(true);
  });

  test("a note that is not UTF-8 is not opened and is not rewritten", async ({ page }) => {
    const note = notePath("not utf8");
    const bytes = Buffer.from([0x61, 0xff, 0xfe, 0x62, 0x0a]);
    writeFileSync(join(VAULT as string, note), bytes);

    await page.addInitScript(installTauriShim);
    await page.goto("/");
    await page.locator("#choose-vault").click();
    await page.locator("#note-path").fill(note);
    await page.locator("#open-note").click();
    await expect(page.locator("#problem")).toHaveText(
      "That note is not UTF-8 text; it is not opened.",
    );
    await expect(page.locator(".cm-content")).toHaveCount(0);
    const writes = (await ipcLog(page)).filter((entry) => entry.command === "write_note");
    expect(writes).toEqual([]);
    expect(onDisk(note).equals(bytes)).toBe(true);
  });

  test("two spaces stay two spaces even when the stylesheet would let WebKit insert a no-break space", async ({
    page,
  }) => {
    const note = notePath("no break space");
    await open(page, note);
    // With `white-space: pre-wrap` (the base theme of CodeMirror) WebKit inserts a plain space.
    // Take that rule away through the CSSOM, as a stylesheet that failed to apply would:
    // the browser's own edit then turns the second space into U+00A0 (measured), so what
    // reaches the note depends on whoever inserts the text, not on the CSS.
    await page.evaluate(() => {
      const root = document.querySelector("#editor")?.shadowRoot;
      if (!root) throw new Error("the editor has no shadow root");
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(".cm-content { white-space: normal !important; }");
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    });
    await type(page, ["a  b   c    d"]);
    await saved(page);
    const written = onDisk(note);
    console.log(`two spaces: ${JSON.stringify(written.toString("utf8"))}`);
    expect(written.equals(Buffer.from("a  b   c    d", "utf8"))).toBe(true);
  });

  test("an undo restores the text without adding any", async ({ page }) => {
    const note = notePath("undo");
    await open(page, note);
    await type(page, ['"quoted"  text']);
    await saved(page);
    expect(onDisk(note).toString("utf8")).toBe('"quoted"  text');
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator("#save-state")).toHaveAttribute("data-state", "dirty");
    await saved(page);
    expect(onDisk(note).toString("utf8")).toBe("");
  });
});

test.describe("CA-41: the live preview changes attributes only", () => {
  const SOURCE_LINES = [
    "# Title",
    "",
    "some *emphasis* and a [link](https://example.test/x) and `code`",
    "",
  ];
  const SOURCE = SOURCE_LINES.join("\n");

  test("the live preview changes attributes only", async ({ page }) => {
    const note = notePath("preview");
    await open(page, note);
    await type(page, SOURCE_LINES);

    // The shell answers with the attribute tree; the editor marks the ranges it names.
    await expect(page.locator('.cm-content [data-md-kind="heading"]')).toHaveCount(1);
    await expect(page.locator('.cm-content [data-md-kind="emphasis"]')).toHaveCount(1);
    await expect(page.locator('.cm-content [data-md-kind="code"]')).toHaveCount(1);
    const link = page.locator('.cm-content [data-md-kind="link"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("data-md-url", "https://example.test/x");
    await expect(page.locator('.cm-content [data-md-kind="heading"]')).toHaveAttribute(
      "data-md-level",
      "1",
    );
    await saved(page);

    // The text is what was typed, after the marks as before them.
    expect(await documentText(page)).toBe(SOURCE);
    expect(onDisk(note).equals(Buffer.from(SOURCE, "utf8"))).toBe(true);

    // Nothing was added to the page but attributes and classes on spans: no link,
    // heading, image or widget exists in the text, and the mark holds the text it wraps.
    const elements = await page.evaluate(() => {
      const root = document.querySelector("#editor")?.shadowRoot;
      if (!root) throw new Error("the editor has no shadow root");
      return {
        foreign: root.querySelectorAll(
          ".cm-content a, .cm-content h1, .cm-content em, .cm-content img, .cm-content code, .cm-content strong",
        ).length,
        tags: Array.from(
          new Set(Array.from(root.querySelectorAll(".cm-content *")).map((e) => e.tagName)),
        ).sort(),
        withHref: root.querySelectorAll(
          ".cm-content [href], .cm-content [src], .cm-content [style]",
        ).length,
        linkText: root.querySelector('.cm-content [data-md-kind="link"]')?.textContent ?? null,
      };
    });
    console.log(`preview: element tags in the text: ${elements.tags.join(" ")}`);
    expect(elements.foreign).toBe(0);
    expect(elements.withHref).toBe(0);
    expect(elements.tags.every((tag) => ["DIV", "SPAN", "BR"].includes(tag))).toBe(true);
    expect(elements.linkText).toBe("[link](https://example.test/x)");

    // The shell was asked about exactly the bytes of the buffer, and nothing was parsed here.
    const previews = (await ipcLog(page)).filter((entry) => entry.command === "render_preview");
    expect(previews.length).toBeGreaterThan(0);
    const latest = previews[previews.length - 1];
    expect(latest?.ok).toBe(true);
    expect(latest?.bytes).toEqual([...Buffer.from(SOURCE, "utf8")]);
  });

  test("hostile Markdown is marked, never interpreted", async ({ page }) => {
    const note = notePath("hostile preview");
    await open(page, note);
    await type(page, [
      "[x](javascript:alert(1)) <img src=x onerror=alert(1)> <script>alert(2)</script>",
      "",
    ]);
    await expect(page.locator("[data-md-blocked]")).toHaveCount(1);
    expect(await page.locator(".cm-content img, .cm-content script, .cm-content a").count()).toBe(
      0,
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
      ),
    ).toEqual([]);
  });
});

test.describe("CA-41 red vector", () => {
  test("a substitution extension is seen red: the typed bytes are not the written bytes", async ({
    page,
  }) => {
    const note = notePath("substituted");
    await open(page, note, "/substituting.html");
    await type(page, TYPED_LINES);
    await saved(page);

    const written = onDisk(note).toString("utf8");
    console.log(`red vector: typed ${JSON.stringify(TYPED)} ; written ${JSON.stringify(written)}`);
    expect(written).not.toBe(TYPED);
    // Each of the three rewrites the extension makes is seen.
    expect(written).toContain("“");
    expect(written).toContain("–");
    expect(written).toContain("…");
  });
});
