// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { corpusDigest, generateCorpus } from "../cr10k";
import { digestDirectory, editCounts, editorLines, editPlan, readFiles } from "./corpus";

// PROTOCOL.md section 10.3: the visible area is compared line by line to the note.
describe("the lines of a note as the editor holds them", () => {
  test("CRLF, CR and LF all end a line, and a final break leaves an empty last line", () => {
    expect(editorLines("a\r\nb\rc\nd\n")).toEqual(["a", "b", "c", "d", ""]);
    expect(editorLines("one line")).toEqual(["one line"]);
  });
});

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

function folder(files: Record<string, Uint8Array<ArrayBufferLike> | string>): string {
  const root = mkdtempSync(join(tmpdir(), "p04-series-corpus-"));
  scratch.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("edit plan (PROTOCOL.md section 10.5)", () => {
  test("the edited paragraph is the one of rank floor(P / 2), counted from 0", () => {
    // Three paragraphs: rank 1 is "b1\nb2", bytes 3 to 8 (the LF at 8 is outside).
    const plan = editPlan(readFiles(folder({ "a.md": "a\n\nb1\nb2\n\nc\n" })));
    expect(plan.items).toEqual([{ path: "a.md", paragraph: { start: 3, end: 8 }, offset: 8 }]);
  });

  test("the offset counts UTF-16 units of the decoded prefix, BOM kept as a unit", () => {
    // BOM (3 bytes, 1 unit), then "é" (2 bytes, 1 unit) and a non-BMP character (4 bytes, 2 units).
    const plan = editPlan(readFiles(folder({ "a.md": "\u{feff}é\u{1f600}\n" })));
    expect(plan.items[0]?.paragraph).toEqual({ start: 0, end: 9 });
    expect(plan.items[0]?.offset).toBe(4);
  });

  test("a lone CR ends a paragraph line as in the oracle, CRLF too", () => {
    const plan = editPlan(readFiles(folder({ "cr.md": "x\r\ry\r", "crlf.md": "x\r\n\r\ny\r\n" })));
    expect(plan.items.map((item) => [item.path, item.offset])).toEqual([
      ["cr.md", 4],
      ["crlf.md", 6],
    ]);
  });

  test("a file that is not UTF-8, or that holds no paragraph, is not editable", () => {
    const plan = editPlan(
      readFiles(
        folder({
          "bad.md": new Uint8Array([0x61, 0xff, 0x0a]),
          "empty.md": "",
          "blank.md": "\n\n",
          "ok.md": "x",
        }),
      ),
    );
    expect(plan.items.map((item) => item.path)).toEqual(["ok.md"]);
    expect(plan.notEditable).toEqual(["bad.md", "blank.md", "empty.md"]);
  });
});

describe("edit counts", () => {
  const before = new Map<string, Uint8Array>([
    ["a.md", bytes("one\n\ntwo\n")],
    ["b.md", bytes("three\n")],
    ["c.md", new Uint8Array([0xff])],
  ]);
  const plan = editPlan(before);

  test("an edit confined to its paragraph conforms", () => {
    const after = new Map(before);
    after.set("a.md", bytes("one\n\ntwop04\n"));
    after.set("b.md", bytes("threep04\n"));
    expect(editCounts(before, after, plan)).toEqual({
      expected: 2,
      examined: 2,
      conforming: 2,
      unexpectedChanges: 0,
    });
  });

  test("an unchanged file is an edit expected and not examined", () => {
    const after = new Map(before);
    after.set("a.md", bytes("one\n\ntwop04\n"));
    expect(editCounts(before, after, plan)).toMatchObject({ examined: 1, conforming: 1 });
  });

  test("a byte changed outside the paragraph is examined and does not conform", () => {
    const after = new Map(before);
    after.set("a.md", bytes("One\n\ntwop04\n"));
    after.set("b.md", bytes("threep04\n"));
    expect(editCounts(before, after, plan)).toMatchObject({ examined: 2, conforming: 1 });
  });

  test("a change of a file that was not edited, or a file added or missing, is unexpected", () => {
    const after = new Map(before);
    after.set("a.md", bytes("one\n\ntwop04\n"));
    after.set("b.md", bytes("threep04\n"));
    after.set("c.md", new Uint8Array([0xfe]));
    after.set("d.md", bytes("new"));
    expect(editCounts(before, after, plan).unexpectedChanges).toBe(2);
    const missing = new Map(after);
    missing.delete("c.md");
    missing.delete("d.md");
    expect(editCounts(before, missing, plan).unexpectedChanges).toBe(1);
  });
});

describe("digest of a copy on disk", () => {
  test("equals the digest of the generator for the same files", () => {
    const files = [...generateCorpus()].slice(0, 30);
    const root = folder(Object.fromEntries(files.map((file) => [file.path, file.bytes])));
    expect(digestDirectory(root)).toEqual(corpusDigest(files));
    // the bytes read back are the bytes written
    const first = files[0];
    if (first === undefined) throw new Error("no file");
    expect(Buffer.compare(readFileSync(join(root, first.path)), first.bytes)).toBe(0);
  });
});
