// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CorpusFile,
  CR10K_SEED,
  corpusDigest,
  generateCorpus,
  LARGE_NOTE_BYTES,
  LARGE_NOTE_INDEX,
  LINKS_PER_NOTE,
  LONG_NOTE_INDEX,
  LONG_NOTE_LINES,
  NOTE_COUNT,
  notePath,
  WIKI_LINK_COUNT,
} from "./cr10k";
import { protocolFields } from "./protocol-fields";

const corpus: CorpusFile[] = [...generateCorpus()];
const decoder = new TextDecoder("utf-8", { fatal: true });

// Detectors are written here from the byte definitions of CA-34, not taken from
// the generator, so that a generator that stops producing a trap cannot also
// stop the test from looking for it.
function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, offset) => bytes[offset] === byte);
}

function hasCrlf(bytes: Uint8Array): boolean {
  return bytes.some((byte, i) => byte === 0x0d && bytes[i + 1] === 0x0a);
}

function hasLoneCr(bytes: Uint8Array): boolean {
  return bytes.some((byte, i) => byte === 0x0d && bytes[i + 1] !== 0x0a);
}

function countFiles(predicate: (file: CorpusFile) => boolean): number {
  return corpus.filter(predicate).length;
}

function text(file: CorpusFile): string {
  return decoder.decode(file.bytes);
}

describe("CR-10k generator (CA-34)", () => {
  test("produces 10 000 distinct note files", () => {
    expect(corpus.length).toBe(10_000);
    expect(NOTE_COUNT).toBe(10_000);
    expect(new Set(corpus.map((file) => file.path)).size).toBe(10_000);
    for (const [index, file] of corpus.entries()) expect(file.path).toBe(notePath(index));
  });

  test("two independent runs give the same overall SHA-256, and the seed is wired in", () => {
    const first = corpusDigest(corpus);
    const second = corpusDigest(generateCorpus());
    expect(second).toEqual(first);
    expect(first.fileCount).toBe(10_000);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // A generator that ignored its seed would pass the equality above.
    expect(corpusDigest(generateCorpus(CR10K_SEED ^ 1)).sha256).not.toBe(first.sha256);
  });

  test("the overall SHA-256 is the one written in PROTOCOL.md", () => {
    const protocol = readFileSync(join(import.meta.dir, "PROTOCOL.md"), "utf8");
    const fields = protocolFields(protocol);
    expect(fields.get("corpus-sha256")).toBe(corpusDigest(corpus).sha256);
    expect(fields.get("corpus-files")).toBe(String(corpus.length));
    expect(fields.get("corpus-seed")).toBe(`0x${CR10K_SEED.toString(16)}`);
  });

  test("holds 60 000 wiki links, six per note, each resolving to a note", () => {
    const stems = new Set(corpus.map((file) => file.path.replace(/^.*\/|\.md$/g, "")));
    let total = 0;
    for (const file of corpus) {
      const targets = [...text(file).matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1]);
      expect(targets.length).toBe(LINKS_PER_NOTE);
      for (const target of targets) expect(stems.has(target ?? "")).toBe(true);
      total += targets.length;
    }
    expect(total).toBe(60_000);
    expect(WIKI_LINK_COUNT).toBe(60_000);
  });

  test("holds one note of exactly 1 Mio and one note of 5 000 lines", () => {
    const large = corpus[LARGE_NOTE_INDEX];
    const long = corpus[LONG_NOTE_INDEX];
    expect(large?.bytes.length).toBe(1_048_576);
    expect(LARGE_NOTE_BYTES).toBe(1_048_576);
    expect(long).toBeDefined();
    const lineFeeds = long?.bytes.filter((byte) => byte === 0x0a).length;
    expect(lineFeeds).toBe(5_000);
    expect(LONG_NOTE_LINES).toBe(5_000);
    expect(long?.bytes.at(-1)).toBe(0x0a);
  });

  describe("byte traps, each present in at least one file", () => {
    test("CRLF", () => {
      expect(countFiles((file) => hasCrlf(file.bytes))).toBeGreaterThan(0);
    });

    test("CR alone", () => {
      expect(countFiles((file) => hasLoneCr(file.bytes))).toBeGreaterThan(0);
    });

    test("BOM", () => {
      expect(countFiles((file) => startsWith(file.bytes, [0xef, 0xbb, 0xbf]))).toBeGreaterThan(0);
    });

    test("tabulations", () => {
      expect(countFiles((file) => file.bytes.includes(0x09))).toBeGreaterThan(0);
    });

    test("trailing spaces at the end of a line", () => {
      expect(countFiles((file) => /[ \t](?=[\r\n])/.test(text(file)))).toBeGreaterThan(0);
    });

    test("end of file without a line break", () => {
      expect(
        countFiles((file) => {
          const last = file.bytes.at(-1);
          return last !== 0x0a && last !== 0x0d;
        }),
      ).toBeGreaterThan(0);
    });

    test("NFD (decomposed accents)", () => {
      expect(countFiles((file) => text(file) !== text(file).normalize("NFC"))).toBeGreaterThan(0);
    });

    test("NFC (precomposed accents)", () => {
      expect(
        countFiles((file) => {
          const content = text(file);
          return content === content.normalize("NFC") && content !== content.normalize("NFD");
        }),
      ).toBeGreaterThan(0);
    });

    test("code points outside the BMP", () => {
      expect(countFiles((file) => /[\u{10000}-\u{10FFFF}]/u.test(text(file)))).toBeGreaterThan(0);
    });
  });

  test("every file is valid UTF-8 and the corpus holds no machine-local path", () => {
    for (const file of corpus) expect(text(file)).not.toContain("/Users/");
  });
});
