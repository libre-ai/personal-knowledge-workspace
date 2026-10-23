// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Byte-for-byte oracle of AT-01 (CA-35, PROTOCOL.md section 2).
//
// Two checks, kept apart because they answer two questions:
//   - round trip: is every file identical after a pass? (SHA-256 per file)
//   - paragraph edit: did an edit leave every byte outside the paragraph alone?
//
// The oracle never accepts an empty universe: zero files examined is a
// failure, not a pass (gate-integrity 2).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SNAPSHOT_SCHEMA = "p04-oracle-snapshot.v1";

export type Snapshot = ReadonlyMap<string, string>;

export interface Mismatch {
  path: string;
  kind: "changed" | "missing" | "added";
}

export interface Comparison {
  examined: number;
  identical: number;
  changed: number;
  missing: number;
  added: number;
  mismatches: Mismatch[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Hash every regular file under `root`, keyed by its "/"-separated relative
// path. Anything that is not a regular file or a directory (a symlink, a socket)
// is an error: it would be counted by neither side of the comparison.
export function snapshotDirectory(root: string): Snapshot {
  const files = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, sha256Hex(readFileSync(absolute)));
      else throw new Error(`oracle: unexpected non-regular entry: ${relative}`);
    }
  };
  walk(root, "");
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function compareSnapshots(before: Snapshot, after: Snapshot): Comparison {
  if (before.size === 0) throw new Error("oracle: the reference snapshot holds no file");
  const mismatches: Mismatch[] = [];
  let identical = 0;
  for (const [path, digest] of before) {
    const current = after.get(path);
    if (current === undefined) mismatches.push({ path, kind: "missing" });
    else if (current !== digest) mismatches.push({ path, kind: "changed" });
    else identical += 1;
  }
  for (const path of after.keys()) {
    if (!before.has(path)) mismatches.push({ path, kind: "added" });
  }
  const count = (kind: Mismatch["kind"]): number =>
    mismatches.filter((mismatch) => mismatch.kind === kind).length;
  return {
    examined: before.size,
    identical,
    changed: count("changed"),
    missing: count("missing"),
    added: count("added"),
    mismatches,
  };
}

export function isIdentical(comparison: Comparison): boolean {
  return comparison.mismatches.length === 0 && comparison.identical === comparison.examined;
}

export function snapshotToJson(snapshot: Snapshot): string {
  return `${JSON.stringify({ schema: SNAPSHOT_SCHEMA, files: Object.fromEntries(snapshot) }, null, 1)}\n`;
}

export function snapshotFromJson(json: string): Snapshot {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("oracle: snapshot is not an object");
  const { schema, files } = parsed as { schema?: unknown; files?: unknown };
  if (schema !== SNAPSHOT_SCHEMA)
    throw new Error(`oracle: snapshot schema is not ${SNAPSHOT_SCHEMA}`);
  if (typeof files !== "object" || files === null) throw new Error("oracle: snapshot has no files");
  const entries = Object.entries(files);
  for (const [path, digest] of entries) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`oracle: snapshot entry is not a SHA-256: ${path}`);
    }
  }
  return new Map(entries as [string, string][]);
}

// Half-open byte range [start, end) in the bytes before the edit.
export interface ByteRange {
  start: number;
  end: number;
}

// Paragraphs of a Markdown file as byte ranges: maximal runs of non-empty lines,
// separated by empty lines. A line ends at LF, CRLF or a lone CR; the range of a
// paragraph stops before the terminator of its last line, so the terminators
// stay outside it. A byte-order mark belongs to the first line.
export function paragraphRanges(bytes: Uint8Array): ByteRange[] {
  const ranges: ByteRange[] = [];
  let paragraphStart: number | null = null;
  let paragraphEnd = 0;
  let lineStart = 0;
  while (lineStart < bytes.length) {
    let contentEnd = lineStart;
    while (contentEnd < bytes.length && bytes[contentEnd] !== 0x0a && bytes[contentEnd] !== 0x0d) {
      contentEnd += 1;
    }
    let next = contentEnd;
    if (bytes[contentEnd] === 0x0d && bytes[contentEnd + 1] === 0x0a) next = contentEnd + 2;
    else if (contentEnd < bytes.length) next = contentEnd + 1;
    if (contentEnd > lineStart) {
      paragraphStart ??= lineStart;
      paragraphEnd = contentEnd;
    } else if (paragraphStart !== null) {
      ranges.push({ start: paragraphStart, end: paragraphEnd });
      paragraphStart = null;
    }
    lineStart = next;
  }
  if (paragraphStart !== null) ranges.push({ start: paragraphStart, end: paragraphEnd });
  return ranges;
}

// `offset` is the first byte found changed outside the paragraph, counted in the
// bytes before the edit.
export type ParagraphVerdict =
  | { ok: true }
  | { ok: false; reason: "prefix-changed" | "tail-changed"; offset: number }
  | { ok: false; reason: "too-short" };

// An edit confined to `paragraph` leaves the bytes before `start` and the bytes
// from `end` untouched; the paragraph itself may change length freely.
export function checkParagraphEdit(
  before: Uint8Array,
  after: Uint8Array,
  paragraph: ByteRange,
): ParagraphVerdict {
  if (paragraph.start < 0 || paragraph.end < paragraph.start || paragraph.end > before.length) {
    throw new Error("oracle: the paragraph range is outside the file");
  }
  for (let offset = 0; offset < paragraph.start; offset += 1) {
    if (after[offset] !== before[offset]) return { ok: false, reason: "prefix-changed", offset };
  }
  const tail = before.length - paragraph.end;
  // Too short to hold the untouched prefix and the untouched tail: no offset is
  // honest here, so none is reported.
  if (after.length < paragraph.start + tail) return { ok: false, reason: "too-short" };
  for (let k = 0; k < tail; k += 1) {
    if (after[after.length - tail + k] !== before[paragraph.end + k]) {
      return { ok: false, reason: "tail-changed", offset: paragraph.end + k };
    }
  }
  return { ok: true };
}

function describe(comparison: Comparison): string {
  return (
    `oracle: examined ${comparison.examined} files, ${comparison.identical} identical, ` +
    `${comparison.changed} changed, ${comparison.missing} missing, ${comparison.added} added`
  );
}

if (import.meta.main) {
  const [command, first, second] = process.argv.slice(2);
  try {
    if (command === "snapshot" && first !== undefined) {
      const snapshot = snapshotDirectory(first);
      if (snapshot.size === 0) throw new Error(`oracle: no file under ${first}`);
      process.stdout.write(snapshotToJson(snapshot));
      console.error(`oracle: snapshot of ${snapshot.size} files`);
    } else if (command === "compare" && first !== undefined && second !== undefined) {
      const comparison = compareSnapshots(
        snapshotFromJson(readFileSync(first, "utf8")),
        snapshotDirectory(second),
      );
      console.log(describe(comparison));
      for (const mismatch of comparison.mismatches.slice(0, 20)) {
        console.log(`oracle: ${mismatch.kind}: ${mismatch.path}`);
      }
      if (!isIdentical(comparison)) {
        console.log("oracle: FAIL");
        process.exit(1);
      }
      console.log("oracle: pass");
    } else {
      console.error(
        "usage: bun oracle.ts snapshot <dir> > <snapshot.json> | bun oracle.ts compare <snapshot.json> <dir>",
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
