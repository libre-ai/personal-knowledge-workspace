// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Deterministic generator of the CR-10k synthetic corpus (CA-34, PROTOCOL.md).
//
// The corpus is a pure function of CR10K_SEED: no clock, no Math.random, no
// environment. Every note depends only on (seed, index), so a subset can be
// regenerated without the rest. All content is synthetic (AGENTS.md).

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CR10K_SEED = 0x50303454;
export const NOTE_COUNT = 10_000;
export const LINKS_PER_NOTE = 6;
export const WIKI_LINK_COUNT = NOTE_COUNT * LINKS_PER_NOTE;
export const LARGE_NOTE_INDEX = 0;
export const LARGE_NOTE_BYTES = 1_048_576;
export const LONG_NOTE_INDEX = 1;
export const LONG_NOTE_LINES = 5_000;

export interface CorpusFile {
  path: string;
  bytes: Uint8Array;
}

type LineEnding = "\n" | "\r\n" | "\r";

interface ByteTraps {
  lineEnding: LineEnding;
  bom: boolean;
  finalNewline: boolean;
  nfd: boolean;
  nonBmp: boolean;
}

const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const encoder = new TextEncoder();

const WORDS = [
  "note",
  "idée",
  "été",
  "élève",
  "naïve",
  "coût",
  "forêt",
  "garçon",
  "œuvre",
  "Noël",
  "cœur",
  "façade",
  "déjà",
  "maïs",
  "hôtel",
  "île",
  "phrase",
  "projet",
  "lecture",
  "archive",
  "source",
  "carnet",
  "index",
  "lien",
  "titre",
  "paragraphe",
  "brouillon",
  "révision",
  "mémoire",
  "fichier",
  "dossier",
  "recherche",
];

// Code points above U+FFFF: two UTF-16 units, four UTF-8 bytes.
const NON_BMP = ["😀", "📝", "𝒳", "𐍈"];

// mulberry32: a 32-bit generator whose whole state is one integer, so the
// stream is identical on every JS engine.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noteRng(seed: number, index: number): () => number {
  return mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

function int(rng: () => number, low: number, high: number): number {
  return low + Math.floor(rng() * (high - low + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[int(rng, 0, items.length - 1)];
  if (item === undefined) throw new Error("pick: empty list");
  return item;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function notePath(index: number): string {
  return `notes/${pad(index % 100, 2)}/note-${pad(index, 5)}.md`;
}

function noteStem(index: number): string {
  return `note-${pad(index, 5)}`;
}

// The two large notes stay free of every byte trap, so that a size or a line
// count is not confounded with an encoding effect. The other notes are assigned
// traps by residue of their index, which makes the distribution reproducible
// and independent of the seed.
function trapsOf(index: number): ByteTraps {
  if (index === LARGE_NOTE_INDEX || index === LONG_NOTE_INDEX) {
    return { lineEnding: "\n", bom: false, finalNewline: true, nfd: false, nonBmp: false };
  }
  return {
    lineEnding: index % 10 === 1 ? "\r\n" : index % 50 === 2 ? "\r" : "\n",
    bom: index % 20 === 3,
    finalNewline: index % 8 !== 4,
    nfd: index % 3 === 0,
    nonBmp: index % 9 === 5,
  };
}

function words(rng: () => number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(pick(rng, WORDS));
  return out.join(" ");
}

// Trailing spaces and tab indentation are byte traps for an editor that trims
// or reindents; they appear in every note that is not one of the two large ones.
function sentence(rng: () => number, trap: boolean): string {
  const text = `${words(rng, int(rng, 5, 12))}.`;
  if (!trap) return text;
  const roll = rng();
  if (roll < 0.1) return `${text}  `;
  if (roll < 0.14) return `${text} `;
  return text;
}

function block(rng: () => number, trap: boolean): string[] {
  const kind = int(rng, 0, 5);
  const lines: string[] = [];
  if (kind === 0) {
    lines.push(`${"#".repeat(int(rng, 1, 3))} ${words(rng, int(rng, 2, 4))}`);
  } else if (kind === 1 || kind === 2) {
    const count = int(rng, 2, 5);
    for (let i = 0; i < count; i += 1) lines.push(sentence(rng, trap));
  } else if (kind === 3) {
    const count = int(rng, 3, 6);
    for (let i = 0; i < count; i += 1) {
      const nested = trap && rng() < 0.3 ? "\t" : "";
      lines.push(`${nested}- ${words(rng, int(rng, 2, 6))}`);
    }
  } else if (kind === 4) {
    lines.push("```ts", `const ${pick(rng, ["a", "b", "c"])} = ${int(rng, 0, 99)};`, "```");
  } else {
    lines.push(`> ${words(rng, int(rng, 4, 9))}`);
  }
  lines.push("");
  return lines;
}

function wikiLine(rng: () => number, self: number): string {
  let target = int(rng, 0, NOTE_COUNT - 1);
  if (target === self) target = (target + 1) % NOTE_COUNT;
  const alias = rng() < 0.3 ? `|${words(rng, 1)}` : "";
  return `- voir [[${noteStem(target)}${alias}]]`;
}

function insertAt<T>(rng: () => number, lines: T[], extra: readonly T[]): void {
  for (const line of extra) lines.splice(int(rng, 0, lines.length), 0, line);
}

function utf8Length(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) total += encoder.encode(line).length + 1;
  return total;
}

function standardBody(rng: () => number, index: number, traps: ByteTraps): string[] {
  const lines: string[] = [];
  if (index % 5 === 0) {
    lines.push(
      "---",
      `title: ${words(rng, 2)}`,
      `tags: [${words(rng, 1)}, ${words(rng, 1)}]`,
      "---",
      "",
    );
  }
  lines.push(`# ${noteStem(index)}`, "");
  const blocks = int(rng, 4, 10);
  for (let i = 0; i < blocks; i += 1) lines.push(...block(rng, true));
  if (traps.nonBmp) lines.push(`${pick(rng, NON_BMP)} ${words(rng, 3)} ${pick(rng, NON_BMP)}`, "");
  return lines;
}

function longBody(rng: () => number): string[] {
  const lines: string[] = ["# long", ""];
  const budget = LONG_NOTE_LINES - LINKS_PER_NOTE;
  for (;;) {
    const next = block(rng, true);
    if (lines.length + next.length > budget) break;
    lines.push(...next);
  }
  while (lines.length < budget) lines.push(sentence(rng, true));
  return lines;
}

function largeBody(rng: () => number): string[] {
  const lines: string[] = ["# large", ""];
  // Room for the six link lines (at most 40 bytes each) and the closing line.
  const budget = LARGE_NOTE_BYTES - 400;
  let size = utf8Length(lines);
  for (;;) {
    const next = block(rng, true);
    const nextSize = utf8Length(next);
    if (size + nextSize > budget) break;
    lines.push(...next);
    size += nextSize;
  }
  return lines;
}

function assemble(lines: readonly string[], traps: ByteTraps): Uint8Array {
  let text = lines.join(traps.lineEnding);
  if (traps.finalNewline) text += traps.lineEnding;
  if (traps.nfd) text = text.normalize("NFD");
  const body = encoder.encode(text);
  if (!traps.bom) return body;
  const out = new Uint8Array(BOM.length + body.length);
  out.set(BOM, 0);
  out.set(body, BOM.length);
  return out;
}

export function generateNote(index: number, seed: number = CR10K_SEED): CorpusFile {
  const rng = noteRng(seed, index);
  const traps = trapsOf(index);
  let lines: string[];
  if (index === LONG_NOTE_INDEX) lines = longBody(rng);
  else if (index === LARGE_NOTE_INDEX) lines = largeBody(rng);
  else lines = standardBody(rng, index, traps);
  const links: string[] = [];
  for (let i = 0; i < LINKS_PER_NOTE; i += 1) links.push(wikiLine(rng, index));
  insertAt(rng, lines, links);
  if (index === LARGE_NOTE_INDEX) {
    // One closing line of plain ASCII brings the file to exactly LARGE_NOTE_BYTES.
    const remaining = LARGE_NOTE_BYTES - utf8Length(lines);
    if (remaining < 2) throw new Error("large note: no room for the closing line");
    lines.push("x".repeat(remaining - 1));
  }
  return { path: notePath(index), bytes: assemble(lines, traps) };
}

export function* generateCorpus(seed: number = CR10K_SEED): Generator<CorpusFile> {
  for (let index = 0; index < NOTE_COUNT; index += 1) yield generateNote(index, seed);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Overall digest: SHA-256 of the lines "<file sha256>  <path>\n" sorted by path,
// the format of `sha256sum`. It binds the content and the name of every file.
export function corpusDigest(files: Iterable<CorpusFile>): { sha256: string; fileCount: number } {
  const entries: string[] = [];
  for (const file of files) entries.push(`${sha256Hex(file.bytes)}  ${file.path}\n`);
  entries.sort((a, b) => {
    const left = a.slice(66);
    const right = b.slice(66);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return {
    sha256: createHash("sha256").update(entries.join("")).digest("hex"),
    fileCount: entries.length,
  };
}

export function writeCorpus(directory: string, seed: number = CR10K_SEED): number {
  mkdirSync(directory, { recursive: true });
  if (readdirSync(directory).length > 0) {
    throw new Error(`refusing to write the corpus into a non-empty directory: ${directory}`);
  }
  let written = 0;
  for (const file of generateCorpus(seed)) {
    const target = join(directory, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
    written += 1;
  }
  return written;
}

if (import.meta.main) {
  const [command, directory] = process.argv.slice(2);
  if (command === "digest") {
    const { sha256, fileCount } = corpusDigest(generateCorpus());
    console.log(`corpus-sha256 ${sha256} (${fileCount} files, seed 0x${CR10K_SEED.toString(16)})`);
  } else if (command === "write" && directory !== undefined) {
    const written = writeCorpus(directory);
    console.log(`wrote ${written} files to ${directory}`);
  } else {
    console.error("usage: bun cr10k.ts digest | bun cr10k.ts write <empty-directory>");
    process.exit(2);
  }
}
