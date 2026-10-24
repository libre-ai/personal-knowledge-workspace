// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-49: the chunks that the accessibility copy of the note is made of stay the
// document, edit after edit, and an edit rewrites only the chunks it changed
// (`src/editor/text-chunks.ts`). The edits are random but seeded: a failure
// prints its seed and step and replays.

import { describe, expect, test } from "bun:test";
import { ChangeSet, type ChangeSpec, Text } from "@codemirror/state";

import { CHUNK_LINES, type Chunk, TextChunks } from "../../src/editor/text-chunks";

function textOf(content: string): Text {
  // One line separator, "\n", as the editor has (`typed-text.ts`): a "\r" stays a character.
  return Text.of(content.split("\n"));
}

function lines(count: number, width = 12): string {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(`line ${index} ${"x".repeat(index % width)}`);
  }
  return out.join("\n");
}

/** Every invariant of `text-chunks.ts`, on the chunks of `doc`. */
function invariants(doc: Text, chunks: readonly Chunk[], chunkLines: number): string[] {
  const found: string[] = [];
  if (chunks.map((chunk) => chunk.text).join("") !== doc.toString()) {
    found.push("the chunks joined are not the document");
  }
  let at = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.from !== at) found.push(`chunk ${index} starts at ${chunk.from}, not ${at}`);
    if (doc.lineAt(chunk.from).from !== chunk.from) {
      found.push(`chunk ${index} does not start a line`);
    }
    if (chunk.text === "" && doc.length > 0) found.push(`chunk ${index} is empty`);
    const count = chunk.text.split("\n").length - (index < chunks.length - 1 ? 1 : 0);
    if (count > 2 * chunkLines) found.push(`chunk ${index} holds ${count} lines`);
    at += chunk.text.length;
  }
  if (new Set(chunks.map((chunk) => chunk.key)).size !== chunks.length) {
    found.push("two chunks share a key");
  }
  return found;
}

// mulberry32, as the corpus generator: the same stream on every engine.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["a", "bc", "\n", "\n\n", "x\ny", "\r", "  ", "\t", "é", "😀", "line\nline\nline\n"];

function randomChange(next: () => number, doc: Text): ChangeSpec[] {
  const count = 1 + Math.floor(next() * 3);
  const points = Array.from({ length: count * 2 }, () => Math.floor(next() * (doc.length + 1)));
  points.sort((a, b) => a - b);
  const specs: ChangeSpec[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = points[2 * index] ?? 0;
    let to = points[2 * index + 1] ?? from;
    const roll = next();
    // Most edits are typing: an insertion, or the deletion of a character or two.
    if (roll < 0.5) to = from;
    else if (roll < 0.8) to = Math.min(from + 1 + Math.floor(next() * 2), to);
    // A large paste now and then, so that chunks grow past twice their size.
    const insert =
      next() < 0.35
        ? ""
        : next() < 0.03
          ? lines(40 + Math.floor(next() * 600))
          : (PIECES[Math.floor(next() * PIECES.length)] ?? "a");
    specs.push({ from, to, insert });
  }
  return specs;
}

describe("the chunks of a document", () => {
  test("a document is cut into whole lines, the last chunk taking the rest", () => {
    const doc = textOf(`${lines(1_000)}\n`);
    const chunks = new TextChunks(doc, 8).chunks;
    expect(invariants(doc, chunks, 8)).toEqual([]);
    // 1 001 lines (the last one empty): 124 chunks of 8 and one of 9.
    expect(chunks.length).toBe(125);
    expect(chunks[chunks.length - 1]?.text.split("\n").length).toBe(9);
  });

  test("the default size cuts the shapes of a note", () => {
    for (const content of ["", "one line", "one line\n", "\n", "\n\n\n", lines(CHUNK_LINES * 3)]) {
      const doc = textOf(content);
      const chunks = new TextChunks(doc).chunks;
      expect(invariants(doc, chunks, CHUNK_LINES)).toEqual([]);
      expect(chunks.length).toBeGreaterThan(0);
    }
  });

  test("a size that is not a positive integer is refused", () => {
    expect(() => new TextChunks(textOf("a"), 0)).toThrow(RangeError);
    expect(() => new TextChunks(textOf("a"), 1.5)).toThrow(RangeError);
  });

  test("a line break typed at the top rewrites the first chunk and no other", () => {
    const doc = textOf(lines(400));
    const chunks = new TextChunks(doc, 16);
    const before = chunks.chunks.map((chunk) => chunk.text);
    const changes = ChangeSet.of({ from: 0, insert: "A\n" }, doc.length);
    const after = changes.apply(doc);
    const result = chunks.update(after, changes);
    expect(invariants(after, result.chunks, 16)).toEqual([]);
    expect([...result.changed]).toEqual([result.chunks[0]?.key ?? -1]);
    expect(result.removed.size).toBe(0);
    expect(result.chunks.slice(1).map((chunk) => chunk.text)).toEqual(before.slice(1));
  });

  test("deleting the line break before a boundary moves the joined line to the next chunk, both rewritten", () => {
    const doc = textOf("x\nyy\nzz\nww\n");
    const chunks = new TextChunks(doc, 2);
    expect(chunks.chunks.map((chunk) => chunk.text)).toEqual(["x\nyy\n", "zz\nww\n"]);
    // The edit is inside the second chunk's new range only: the first chunk loses
    // its last line without being reached by it.
    const at = doc.toString().indexOf("yy") + 2;
    const changes = ChangeSet.of({ from: at, to: at + 1 }, doc.length);
    const after = changes.apply(doc);
    const result = chunks.update(after, changes);
    expect(invariants(after, result.chunks, 2)).toEqual([]);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["x\n", "yyzz\nww\n"]);
    expect(result.changed.size).toBe(2);
    expect(result.removed.size).toBe(0);
  });

  test("deleting the line break of a one-line chunk merges it into the chunk before", () => {
    const doc = textOf("a\nbb\ncc\ndd\n");
    const chunks = new TextChunks(doc, 1);
    // Lines of one each but the last chunk, which takes "dd" and the empty line.
    expect(chunks.chunks.map((chunk) => chunk.text)).toEqual(["a\n", "bb\n", "cc\n", "dd\n"]);
    const at = doc.toString().indexOf("bb") + 2;
    const changes = ChangeSet.of({ from: at, to: at + 1 }, doc.length);
    const after = changes.apply(doc);
    const result = chunks.update(after, changes);
    expect(invariants(after, result.chunks, 1)).toEqual([]);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["a\n", "bbcc\n", "dd\n"]);
    expect(result.removed.size).toBe(1);
    expect(result.changed.size).toBe(1);
  });

  test("a chunk that grows past twice its size is cut again, its first piece keeping its key", () => {
    const doc = textOf("a\nb\nc\n");
    const chunks = new TextChunks(doc, 2);
    // "a", "b" | "c" and the empty line after it.
    expect(chunks.chunks.map((chunk) => chunk.text)).toEqual(["a\nb\n", "c\n"]);
    const [grown, untouched] = chunks.chunks;
    const changes = ChangeSet.of({ from: 0, insert: `${lines(20)}\n` }, doc.length);
    const after = changes.apply(doc);
    const result = chunks.update(after, changes);
    expect(invariants(after, result.chunks, 2)).toEqual([]);
    expect(result.chunks[0]?.key).toBe(grown?.key);
    // 22 lines cut into pieces of 2: 11 pieces, then the untouched chunk.
    expect(result.chunks.length).toBe(12);
    expect(result.chunks[11]).toEqual({
      key: untouched?.key ?? -1,
      from: after.length - 2,
      text: "c\n",
    });
    expect(result.changed.size).toBe(11);
    expect(result.changed.has(untouched?.key ?? -1)).toBe(false);
  });

  test("deleting the last line leaves no empty chunk after the final line break", () => {
    const doc = textOf("a\nb\n");
    const chunks = new TextChunks(doc, 1);
    expect(chunks.chunks.map((chunk) => chunk.text)).toEqual(["a\n", "b\n"]);
    const changes = ChangeSet.of({ from: 2, to: 4 }, doc.length);
    const after = changes.apply(doc);
    const result = chunks.update(after, changes);
    expect(invariants(after, result.chunks, 1)).toEqual([]);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(["a\n"]);
    expect(result.removed.size).toBe(1);
  });

  test("deleting everything leaves one empty chunk, typing again fills it", () => {
    const doc = textOf(lines(100));
    const chunks = new TextChunks(doc, 4);
    const cleared = ChangeSet.of({ from: 0, to: doc.length }, doc.length);
    const empty = cleared.apply(doc);
    const result = chunks.update(empty, cleared);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual([""]);
    expect(result.removed.size + 1).toBe(new TextChunks(doc, 4).chunks.length);
    const typed = ChangeSet.of({ from: 0, insert: "x" }, 0);
    const again = chunks.update(typed.apply(empty), typed);
    expect(again.chunks.map((chunk) => chunk.text)).toEqual(["x"]);
    expect(again.changed.size).toBe(1);
  });

  for (const seed of [1, 2, 3, 0x50303454]) {
    test(`random edits keep every invariant and report exactly the chunks they changed (seed ${seed})`, () => {
      const next = random(seed);
      const chunkLines = 1 + (seed % 7);
      let doc = textOf(lines(300));
      const chunks = new TextChunks(doc, chunkLines);
      let rewritten = 0;
      let kept = 0;
      for (let step = 0; step < 1_500; step += 1) {
        const before = new Map(chunks.chunks.map((chunk) => [chunk.key, chunk.text]));
        const changes = ChangeSet.of(randomChange(next, doc), doc.length);
        doc = changes.apply(doc);
        const result = chunks.update(doc, changes);
        const where = `seed ${seed}, step ${step}`;
        expect({ where, found: invariants(doc, result.chunks, chunkLines) }).toEqual({
          where,
          found: [],
        });
        expect(result.chunks).toBe(chunks.chunks);
        for (const chunk of result.chunks) {
          const previous = before.get(chunk.key);
          const differs = previous === undefined || previous !== chunk.text;
          expect({ where, key: chunk.key, reported: result.changed.has(chunk.key) }).toEqual({
            where,
            key: chunk.key,
            reported: differs,
          });
          if (differs) rewritten += 1;
          else kept += 1;
        }
        const now = new Set(result.chunks.map((chunk) => chunk.key));
        const gone = [...before.keys()].filter((key) => !now.has(key));
        expect({ where, removed: [...result.removed].sort() }).toEqual({
          where,
          removed: gone.sort(),
        });
      }
      console.log(
        `seed ${seed}: 1500 edits, ${rewritten} chunk rewrites, ${kept} chunks kept as they were`,
      );
      expect(kept).toBeGreaterThan(rewritten);
    });
  }
});
