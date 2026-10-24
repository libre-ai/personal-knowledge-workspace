// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The text of a document cut into chunks of whole lines, kept in step with its
// edits, for the copy of the note that the accessibility tree reads
// (`accessible-text.ts`, EF-P04-11). It holds no DOM, so that its rules are
// tested without a browser.
//
// Why chunks: CodeMirror draws the visible lines only, and a copy of the whole
// note in one text node would be rewritten, and laid out again, at every
// keystroke (the 1 MiB note of CR-10k is close to a million characters). Cut
// into chunks, an edit rewrites the chunks whose text it changed, and no other.
//
// Why whole lines: a chunk becomes one block of the page, and a block boundary
// inside a line would show assistive technologies a line break the note does
// not have. Each chunk but the last ends with the line break of its last line.
//
// Why the boundaries are offsets mapped through the edits, not line numbers: a
// line break typed at the top of the note moves every line number after it; a
// boundary that follows the text does not move, and the chunks after the edit
// keep their text.
//
// The invariants, replayed on random edits by `tests/editor/text-chunks.test.ts`:
// the texts of the chunks, joined, are the document; every chunk starts at the
// start of a line; no chunk is empty unless the document is; no chunk holds more
// than twice `chunkLines` lines; a chunk is reported changed only when its text
// changed, and every chunk whose text changed is reported.
//
// shortcut: a chunk is whole lines, so a line of a million characters is one
// chunk, rewritten whole at each keystroke in it. Upgrade trigger: such a line
// shows in the typing latency of AT-02 (work package WP-5).

import type { ChangeSet, Text } from "@codemirror/state";

/** Lines per chunk when a document is cut; a chunk is cut again past twice this. */
export const CHUNK_LINES = 256;

export interface Chunk {
  /** Stable for the life of the chunk: its copy in the page is found by it. */
  readonly key: number;
  /** Offset of its first character, the start of a line. */
  readonly from: number;
  readonly text: string;
}

export interface ChunkChanges {
  /** The chunks after the edit, in document order. */
  readonly chunks: readonly Chunk[];
  /** Keys of the chunks that are new or whose text changed. */
  readonly changed: ReadonlySet<number>;
  /** Keys of the chunks that no longer exist. */
  readonly removed: ReadonlySet<number>;
}

interface Slot {
  key: number;
  from: number;
  text: string;
}

/** The last line of a chunk that ends at `to`: `to` starts the next chunk, or ends the document. */
function lastLine(doc: Text, to: number): number {
  return to === doc.length ? doc.lines : doc.lineAt(to).number - 1;
}

export class TextChunks {
  readonly #chunkLines: number;
  #slots: Slot[];
  #nextKey = 0;

  constructor(doc: Text, chunkLines: number = CHUNK_LINES) {
    if (!Number.isInteger(chunkLines) || chunkLines < 1) {
      throw new RangeError("chunkLines must be a positive integer");
    }
    this.#chunkLines = chunkLines;
    this.#slots = this.#cut(doc, 0, doc.length, null);
  }

  get chunks(): readonly Chunk[] {
    return this.#slots;
  }

  /**
   * Brings the chunks in step with `doc`, the document after `changes`; the
   * changes apply to the document the chunks were last in step with.
   */
  update(doc: Text, changes: ChangeSet): ChunkChanges {
    const ranges: Array<readonly [number, number]> = [];
    changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      ranges.push([fromB, toB]);
    });

    // Where each boundary goes. Text inserted at a boundary belongs to the chunk
    // that starts there (assoc -1 keeps the boundary before it). A boundary whose
    // line break was deleted is now inside a line: it goes back to the start of
    // that line. A boundary that meets the one before it, or the end of a
    // document it does not start, is gone, and its chunk with it.
    const mapped = this.#slots.map((slot) => changes.mapPos(slot.from, -1));
    const kept: Array<{ slot: Slot; index: number; from: number; moved: boolean }> = [];
    const removed = new Set<number>();
    for (const [index, slot] of this.#slots.entries()) {
      const at = mapped[index] ?? 0;
      const from = index === 0 ? 0 : doc.lineAt(at).from;
      const previous = kept[kept.length - 1];
      if (previous !== undefined && (from <= previous.from || from === doc.length)) {
        removed.add(slot.key);
        continue;
      }
      kept.push({ slot, index, from, moved: from !== at });
    }

    const changed = new Set<number>();
    const result: Slot[] = [];
    for (const [index, entry] of kept.entries()) {
      const following = kept[index + 1];
      const to = following?.from ?? doc.length;
      // A chunk is read again when an edit reaches it, or when one of its two
      // boundaries moved other than with the text (a line break deleted at it, the
      // next chunk gone into it).
      const reached = ranges.some(([fromB, toB]) => fromB <= to && toB >= entry.from);
      const end = mapped[entry.index + 1] ?? doc.length;
      const bounds = entry.moved || to !== end;
      const slot = entry.slot;
      slot.from = entry.from;
      if (!reached && !bounds) {
        result.push(slot);
        continue;
      }
      if (lastLine(doc, to) - doc.lineAt(entry.from).number + 1 > 2 * this.#chunkLines) {
        const pieces = this.#cut(doc, entry.from, to, slot.key);
        for (const piece of pieces) changed.add(piece.key);
        result.push(...pieces);
        continue;
      }
      const text = doc.sliceString(entry.from, to);
      if (text !== slot.text) {
        slot.text = text;
        changed.add(slot.key);
      }
      result.push(slot);
    }
    this.#slots = result;
    return { chunks: result, changed, removed };
  }

  /**
   * `[from, to)` cut into chunks of `chunkLines` lines, the last one taking the
   * rest (from `chunkLines` to twice that, or fewer for a short document). The
   * first chunk takes `firstKey` when one is given: its copy in the page is reused.
   */
  #cut(doc: Text, from: number, to: number, firstKey: number | null): Slot[] {
    const slots: Slot[] = [];
    const last = lastLine(doc, to);
    let line = doc.lineAt(from).number;
    do {
      const remaining = last - line + 1;
      let take = remaining < 2 * this.#chunkLines ? remaining : this.#chunkLines;
      // The empty line after a final line break is not a chunk of its own.
      if (line + take <= last && doc.line(line + take).from === doc.length) take = remaining;
      const start = doc.line(line).from;
      const end = line + take > last ? to : doc.line(line + take).from;
      const key = slots.length === 0 && firstKey !== null ? firstKey : this.#nextKey++;
      slots.push({ key, from: start, text: doc.sliceString(start, end) });
      line += take;
    } while (line <= last);
    return slots;
  }
}
