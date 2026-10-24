// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The corpus side of AT-01 (PROTOCOL.md section 10.5): which files are
// editable, which paragraph of each is edited and where the caret goes, and
// how the bytes after a pass are counted against the bytes before it.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type CorpusFile, corpusDigest } from "../cr10k";
import { type ByteRange, checkParagraphEdit, paragraphRanges } from "../oracle";
import type { EditPass } from "./evaluate";

/** Every regular file under `root`, keyed by its "/"-separated path, sorted by path. */
export function readFiles(root: string): Map<string, Uint8Array> {
  const files: [string, Uint8Array][] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else if (entry.isFile())
        files.push([relative, new Uint8Array(readFileSync(join(directory, entry.name)))]);
      else throw new Error(`corpus: unexpected non-regular entry: ${relative}`);
    }
  };
  walk(root, "");
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new Map(files);
}

/** The digest of `cr10k.ts`, computed from the files on disk (a fresh copy is checked against PROTOCOL.md). */
export function digestDirectory(root: string): { sha256: string; fileCount: number } {
  const files: CorpusFile[] = [...readFiles(root)].map(([path, bytes]) => ({ path, bytes }));
  return corpusDigest(files);
}

export interface EditItem {
  path: string;
  paragraph: ByteRange;
  /** Caret position in the editor: UTF-16 units of the decoded bytes before the paragraph end. */
  offset: number;
}

export interface EditPlan {
  items: EditItem[];
  notEditable: string[];
}

// As the editor decodes a note: strict UTF-8, a leading byte-order mark kept as a character.
function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function editPlan(files: ReadonlyMap<string, Uint8Array>): EditPlan {
  const items: EditItem[] = [];
  const notEditable: string[] = [];
  for (const [path, bytes] of files) {
    const paragraphs = paragraphRanges(bytes);
    const paragraph = paragraphs[Math.floor(paragraphs.length / 2)];
    if (decode(bytes) === null || paragraph === undefined) {
      notEditable.push(path);
      continue;
    }
    // The end of a paragraph is before an ASCII terminator or at the end of the
    // file, never inside a multi-byte sequence: the prefix decodes on its own.
    const prefix = decode(bytes.subarray(0, paragraph.end));
    if (prefix === null) throw new Error(`corpus: the prefix of ${path} does not decode`);
    items.push({ path, paragraph, offset: prefix.length });
  }
  return { items, notEditable };
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function editCounts(
  before: ReadonlyMap<string, Uint8Array>,
  after: ReadonlyMap<string, Uint8Array>,
  plan: EditPlan,
): EditPass {
  const edited = new Map(plan.items.map((item) => [item.path, item]));
  let examined = 0;
  let conforming = 0;
  let unexpectedChanges = 0;
  for (const [path, original] of before) {
    const current = after.get(path);
    const item = edited.get(path);
    if (item === undefined) {
      if (current === undefined || !same(original, current)) unexpectedChanges += 1;
      continue;
    }
    if (current === undefined) {
      unexpectedChanges += 1;
      continue;
    }
    if (same(original, current)) continue; // expected, not observed
    examined += 1;
    if (checkParagraphEdit(original, current, item.paragraph).ok) conforming += 1;
  }
  for (const path of after.keys()) if (!before.has(path)) unexpectedChanges += 1;
  return { expected: plan.items.length, examined, conforming, unexpectedChanges };
}
