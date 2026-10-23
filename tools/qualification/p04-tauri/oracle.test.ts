// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateNote, writeCorpus } from "./cr10k";
import {
  type ByteRange,
  checkParagraphEdit,
  compareSnapshots,
  isIdentical,
  paragraphRanges,
  snapshotDirectory,
  snapshotFromJson,
  snapshotToJson,
} from "./oracle";

const oracleScript = join(import.meta.dir, "oracle.ts");
const work = mkdtempSync(join(tmpdir(), "p04-oracle-"));
const beforeDirectory = join(work, "before");
const afterDirectory = join(work, "after");
const mutated = "notes/42/note-00042.md";

beforeAll(() => {
  writeCorpus(beforeDirectory);
  cpSync(beforeDirectory, afterDirectory, { recursive: true });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

// The child process gets an empty environment: nothing of the surrounding CI or
// terminal (colour, locale, NODE_OPTIONS) can change what it prints or returns.
function runOracle(...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, oracleScript, ...args], { env: {} });
  return {
    status: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function flipByte(path: string, offset: number): Uint8Array {
  const original = readFileSync(path);
  const changed = Uint8Array.from(original);
  changed[offset] = (changed[offset] ?? 0) ^ 0x01;
  writeFileSync(path, changed);
  return original;
}

describe("round trip over CR-10k (CA-35)", () => {
  test("nominal: an untouched copy is identical, 10 000 of 10 000 files", () => {
    const comparison = compareSnapshots(
      snapshotDirectory(beforeDirectory),
      snapshotDirectory(afterDirectory),
    );
    expect(comparison.examined).toBe(10_000);
    expect(comparison.identical).toBe(10_000);
    expect(comparison.mismatches).toEqual([]);
    expect(isIdentical(comparison)).toBe(true);
  });

  test("red vector 1: one byte changed in one file is reported, then restored and green", () => {
    const target = join(afterDirectory, mutated);
    const original = flipByte(target, 100);
    try {
      const red = compareSnapshots(
        snapshotDirectory(beforeDirectory),
        snapshotDirectory(afterDirectory),
      );
      expect(isIdentical(red)).toBe(false);
      expect(red.mismatches).toEqual([{ path: mutated, kind: "changed" }]);
      expect(red.identical).toBe(9_999);
      expect(red.examined).toBe(10_000);
    } finally {
      writeFileSync(target, original);
    }
    const green = compareSnapshots(
      snapshotDirectory(beforeDirectory),
      snapshotDirectory(afterDirectory),
    );
    expect(isIdentical(green)).toBe(true);
  });

  test("a single byte changed in the last position of the 1 Mio note is reported", () => {
    const target = join(afterDirectory, "notes/00/note-00000.md");
    const original = flipByte(target, 1_048_575);
    try {
      const red = compareSnapshots(
        snapshotDirectory(beforeDirectory),
        snapshotDirectory(afterDirectory),
      );
      expect(red.mismatches).toEqual([{ path: "notes/00/note-00000.md", kind: "changed" }]);
    } finally {
      writeFileSync(target, original);
    }
  });

  test("a missing file and an added file are reported, and are not counted identical", () => {
    const before = snapshotDirectory(beforeDirectory);
    const after = new Map(snapshotDirectory(afterDirectory));
    after.delete(mutated);
    after.set("notes/99/extra.md", "0".repeat(64));
    const comparison = compareSnapshots(before, after);
    expect(comparison.missing).toBe(1);
    expect(comparison.added).toBe(1);
    expect(comparison.identical).toBe(9_999);
    expect(isIdentical(comparison)).toBe(false);
  });

  test("an empty reference is a failure, never a pass", () => {
    expect(() => compareSnapshots(new Map(), new Map())).toThrow("holds no file");
  });

  test("the snapshot survives its JSON form and refuses a malformed one", () => {
    const snapshot = snapshotDirectory(beforeDirectory);
    expect(snapshotFromJson(snapshotToJson(snapshot))).toEqual(snapshot);
    expect(() => snapshotFromJson('{"schema":"other","files":{}}')).toThrow("schema");
    expect(() =>
      snapshotFromJson('{"schema":"p04-oracle-snapshot.v1","files":{"a.md":"nothex"}}'),
    ).toThrow("not a SHA-256");
  });
});

describe("oracle command line", () => {
  test("snapshot then compare: exit 0 on a copy, 1 on a mutated byte, 2 on an unreadable source", () => {
    const snapshotFile = join(work, "snapshot.json");
    const snapshot = runOracle("snapshot", beforeDirectory);
    expect(snapshot.status).toBe(0);
    expect(snapshot.stderr).toContain("snapshot of 10000 files");
    writeFileSync(snapshotFile, snapshot.stdout);

    const green = runOracle("compare", snapshotFile, afterDirectory);
    expect(green.status).toBe(0);
    expect(green.stdout).toContain("examined 10000 files, 10000 identical");
    expect(green.stdout).toContain("oracle: pass");

    const target = join(afterDirectory, mutated);
    const original = flipByte(target, 7);
    try {
      const red = runOracle("compare", snapshotFile, afterDirectory);
      expect(red.status).toBe(1);
      expect(red.stdout).toContain("9999 identical, 1 changed");
      expect(red.stdout).toContain(`changed: ${mutated}`);
      expect(red.stdout).toContain("oracle: FAIL");
    } finally {
      writeFileSync(target, original);
    }

    const unreadable = runOracle("compare", snapshotFile, join(work, "does-not-exist"));
    expect(unreadable.status).toBe(2);
  });

  test("an empty directory gives no snapshot, and an empty snapshot gives no verdict (exit 2)", () => {
    const empty = mkdtempSync(join(work, "empty-"));
    const snapshot = runOracle("snapshot", empty);
    expect(snapshot.status).toBe(2);
    expect(snapshot.stderr).toContain("no file under");
    expect(snapshot.stdout).toBe("");

    const emptySnapshotFile = join(work, "empty-snapshot.json");
    writeFileSync(emptySnapshotFile, '{"schema":"p04-oracle-snapshot.v1","files":{}}');
    const compare = runOracle("compare", emptySnapshotFile, afterDirectory);
    expect(compare.status).toBe(2);
    expect(compare.stderr).toContain("holds no file");
  });
});

describe("paragraph bound (CA-35)", () => {
  test("paragraph ranges of a hand-written buffer with LF, CRLF and CR", () => {
    // a\n\nb\r\nc\r\rd : paragraphs "a", "b\r\nc" and "d"
    const bytes = new TextEncoder().encode("a\n\nb\r\nc\r\rd");
    expect(paragraphRanges(bytes)).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 7 },
      { start: 9, end: 10 },
    ]);
  });

  function paragraphOf(index: number): { before: Uint8Array; paragraph: ByteRange } {
    const before = generateNote(index).bytes;
    const paragraph = paragraphRanges(before)[3];
    if (paragraph === undefined) throw new Error(`note ${index} has fewer than four paragraphs`);
    return { before, paragraph };
  }

  function replaceParagraph(before: Uint8Array, paragraph: ByteRange, text: string): Uint8Array {
    const replacement = new TextEncoder().encode(text);
    const out = new Uint8Array(
      before.length - (paragraph.end - paragraph.start) + replacement.length,
    );
    out.set(before.subarray(0, paragraph.start), 0);
    out.set(replacement, paragraph.start);
    out.set(before.subarray(paragraph.end), paragraph.start + replacement.length);
    return out;
  }

  // Index 7 is LF, 11 is CRLF, 52 is CR alone: the three line endings of the corpus.
  for (const index of [7, 11, 52]) {
    test(`nominal: a longer and a shorter paragraph stay in bounds (note ${index})`, () => {
      const { before, paragraph } = paragraphOf(index);
      const longer = replaceParagraph(
        before,
        paragraph,
        "édité, plus long que l'original. ".repeat(5),
      );
      expect(checkParagraphEdit(before, longer, paragraph)).toEqual({ ok: true });
      const shorter = replaceParagraph(before, paragraph, "x");
      expect(checkParagraphEdit(before, shorter, paragraph).ok).toBe(true);
    });

    test(`red vector 2: a byte changed outside the paragraph is reported (note ${index})`, () => {
      const { before, paragraph } = paragraphOf(index);
      const edited = replaceParagraph(before, paragraph, "édité");
      const growth = edited.length - before.length;

      const beforeSide = Uint8Array.from(edited);
      beforeSide[0] = (beforeSide[0] ?? 0) ^ 0x01;
      expect(checkParagraphEdit(before, beforeSide, paragraph)).toEqual({
        ok: false,
        reason: "prefix-changed",
        offset: 0,
      });

      const afterSide = Uint8Array.from(edited);
      const lastOffset = afterSide.length - 1;
      afterSide[lastOffset] = (afterSide[lastOffset] ?? 0) ^ 0x01;
      expect(checkParagraphEdit(before, afterSide, paragraph)).toEqual({
        ok: false,
        reason: "tail-changed",
        offset: lastOffset - growth,
      });
    });
  }

  test("the boundary is exact: first and last paragraph byte are inside, their neighbours outside", () => {
    const { before, paragraph } = paragraphOf(7);
    const flipped = (offset: number): Uint8Array => {
      const copy = Uint8Array.from(before);
      copy[offset] = (copy[offset] ?? 0) ^ 0x01;
      return copy;
    };
    expect(checkParagraphEdit(before, flipped(paragraph.start), paragraph).ok).toBe(true);
    expect(checkParagraphEdit(before, flipped(paragraph.end - 1), paragraph).ok).toBe(true);
    expect(checkParagraphEdit(before, flipped(paragraph.start - 1), paragraph).ok).toBe(false);
    expect(checkParagraphEdit(before, flipped(paragraph.end), paragraph).ok).toBe(false);
  });

  test("a truncated file and an out-of-range paragraph are not accepted", () => {
    const { before, paragraph } = paragraphOf(7);
    // The prefix is intact, the tail is gone: only the length check can say so.
    expect(checkParagraphEdit(before, before.subarray(0, paragraph.start), paragraph)).toEqual({
      ok: false,
      reason: "too-short",
    });
    expect(() => checkParagraphEdit(before, before, { start: 0, end: before.length + 1 })).toThrow(
      "outside the file",
    );
  });
});
