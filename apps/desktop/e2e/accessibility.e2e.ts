// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-49, in Playwright WebKit: the accessibility tree of the editor holds the
// whole text of the open note, the lines CodeMirror does not draw included, and
// holding it changes no byte of the note (AT-01). The note is the 1 MiB note of
// CR-10k (`tools/qualification/p04-tauri/cr10k.ts`), written into the vault of
// the run. How the tree is read: `accessibility.ts`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import {
  generateNote,
  LARGE_NOTE_BYTES,
  LARGE_NOTE_INDEX,
} from "../../../tools/qualification/p04-tauri/cr10k";
import { percent, readAccessibleText } from "./accessibility";
import type { IpcLogEntry } from "./shim";
import { installTauriShim } from "./shim";

const VAULT = process.env.P04_E2E_VAULT;
if (VAULT === undefined) throw new Error("P04_E2E_VAULT is not set: playwright.config.ts sets it");

/** The text of a note as the editor reads it (`note-session.ts`: strict UTF-8, a BOM kept). */
function textOf(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Writes note `index` of CR-10k into the vault under its corpus path, once per run. */
function corpusNote(index: number): { path: string; bytes: Uint8Array } {
  const note = generateNote(index);
  const target = join(VAULT as string, note.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, note.bytes);
  return note;
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

async function writes(page: Page): Promise<IpcLogEntry[]> {
  const log = await page.evaluate(
    () => (window as unknown as { __ipcLog: IpcLogEntry[] }).__ipcLog,
  );
  return log.filter((entry) => entry.command === "write_note");
}

/** How many lines CodeMirror draws: the ones of the visible part, not the note's. */
async function drawnLines(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.querySelector("#editor")?.shadowRoot?.querySelectorAll(".cm-content .cm-line")
        .length ?? 0,
  );
}

test.describe("CA-49: the editor exposes the whole note to accessibility", () => {
  test("the accessibility tree of the editor holds the 1 MiB note of CR-10k at every position", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const note = corpusNote(LARGE_NOTE_INDEX);
    expect(note.bytes.length).toBe(LARGE_NOTE_BYTES);
    const expected = textOf(note.bytes);

    await open(page, note.path);
    const drawn = await drawnLines(page);
    expect(drawn).toBeLessThan(note.bytes.length / 1_000);
    const reading = await readAccessibleText(page, "#editor", expected);
    console.log(
      `CA-49: ${note.path}, ${note.bytes.length} bytes, ${expected.length} UTF-16 units; ` +
        `lines drawn by CodeMirror ${drawn}; text-carrying nodes ${reading.carriers}; ` +
        `tree text ${percent(reading.tree)}; element text ${percent(reading.elements)}; ` +
        `text nodes ${reading.textNodes}, white space collapsed in ${reading.collapsed}`,
    );
    expect(reading.tree.firstDifference).toBeNull();
    expect(reading.tree.ratio).toBe(1);
    expect(reading.elements.firstDifference).toBeNull();
    expect(reading.elements.ratio).toBe(1);
    expect(reading.textNodes).toBeGreaterThan(0);
    expect(reading.collapsed).toBe(0);

    // AT-01: opening and exposing the note wrote nothing.
    expect(await writes(page)).toEqual([]);
    expect(onDisk(note.path).equals(Buffer.from(note.bytes))).toBe(true);
  });

  test("the tree follows the edits and the note keeps every byte that was not typed", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const note = corpusNote(LARGE_NOTE_INDEX);
    await open(page, note.path);

    // A character, a line break, its deletion and a line break again, at the top of
    // the note: every line after them moves, and the tree must follow.
    await page.locator(".cm-content .cm-line").first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await page.keyboard.type("A");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Enter");
    await expect(page.locator("#save-state")).toHaveAttribute("data-state", "saved", {
      timeout: 60_000,
    });

    const expected = Buffer.concat([Buffer.from("A\n"), Buffer.from(note.bytes)]);
    // AT-01: what is on disk is the note and the two characters the typing left.
    expect(onDisk(note.path).equals(expected)).toBe(true);
    const reading = await readAccessibleText(page, "#editor", textOf(expected));
    console.log(
      `CA-49 after edits: tree text ${percent(reading.tree)}; element text ${percent(reading.elements)}; ` +
        `text nodes ${reading.textNodes}, white space collapsed in ${reading.collapsed}`,
    );
    expect(reading.tree.ratio).toBe(1);
    expect(reading.elements.ratio).toBe(1);
    expect(reading.collapsed).toBe(0);
  });
});

test.describe("CA-49 red vector", () => {
  test("the editor without its accessible copy is seen red: the tree holds its label, not the note", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const note = corpusNote(LARGE_NOTE_INDEX);
    const expected = textOf(note.bytes);
    await page.addInitScript(installTauriShim);
    await page.goto("/without-accessible-text.html");
    await page.evaluate(
      (path) =>
        (
          window as unknown as { openWithoutAccessibleText: (path: string) => Promise<void> }
        ).openWithoutAccessibleText(path),
      note.path,
    );
    await expect(page.locator("#state")).toHaveAttribute("data-state", "open");
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.locator("#editor").getByRole("textbox", { name: "Note text" })).toHaveCount(
      1,
    );

    const reading = await readAccessibleText(page, "#editor", expected);
    console.log(
      `CA-49 red vector: lines drawn by CodeMirror ${await drawnLines(page)}; ` +
        `tree text ${percent(reading.tree)}; element text ${percent(reading.elements)}`,
    );
    expect(reading.tree.ratio).toBeLessThan(1);
    expect(reading.elements.ratio).toBeLessThan(1);
  });
});
