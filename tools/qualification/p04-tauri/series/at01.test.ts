// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type At01Steps, at01Series } from "./at01";
import { Interrupted, type Interruption, Streak, Unavailable } from "./attempts";
import type { EditPlan } from "./corpus";

const scratch: string[] = [];
afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

// A corpus of three files: two editable, one that does not decode in UTF-8.
const CORPUS: Record<string, Uint8Array> = {
  "notes/a.md": new TextEncoder().encode("# a\n\nfirst paragraph\n\nsecond\n"),
  "notes/b.md": new TextEncoder().encode("only one\n"),
  "notes/c.bin": new Uint8Array([0xff, 0xfe, 0x0a]),
};

function write(root: string, path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

// Inserts `text` at the end of the planned paragraph of every editable file, as the
// shell does when the edit is right.
function editAsPlanned(vault: string, plan: EditPlan, text = "p04"): void {
  for (const item of plan.items) {
    const bytes = new Uint8Array(readFileSync(join(vault, item.path)));
    const inserted = new TextEncoder().encode(text);
    const out = new Uint8Array(bytes.length + inserted.length);
    out.set(bytes.subarray(0, item.paragraph.end), 0);
    out.set(inserted, item.paragraph.end);
    out.set(bytes.subarray(item.paragraph.end), item.paragraph.end + inserted.length);
    writeFileSync(join(vault, item.path), out);
  }
}

interface Recorder {
  log: string[];
  copies: number;
  disposed: number;
}

function steps(
  recorder: Recorder,
  launches: {
    roundTrip?: (vault: string, attempt: number) => void;
    edit?: (vault: string, plan: EditPlan, attempt: number) => void;
  },
): At01Steps {
  let roundTrips = 0;
  let edits = 0;
  return {
    freshCopy() {
      recorder.copies += 1;
      const parent = mkdtempSync(join(tmpdir(), "p04-at01-"));
      scratch.push(parent);
      const vault = join(parent, "vault");
      for (const [path, bytes] of Object.entries(CORPUS)) write(vault, path, bytes);
      recorder.log.push(`copy:${vault}`);
      return {
        vault,
        dispose: () => {
          recorder.disposed += 1;
        },
      };
    },
    async roundTripLaunch(vault, paths, unit) {
      roundTrips += 1;
      recorder.log.push(`round-trip:${vault}:${paths.length}:${unit}`);
      launches.roundTrip?.(vault, roundTrips);
    },
    async editLaunch(vault, plan, unit) {
      edits += 1;
      recorder.log.push(`edit:${vault}:${unit}`);
      (launches.edit ?? ((target, chosen) => editAsPlanned(target, chosen)))(vault, plan, edits);
    },
  };
}

const recorder = (): Recorder => ({ log: [], copies: 0, disposed: 0 });

// PROTOCOL.md section 10.5: a pass is a fresh copy, a first launch that opens and
// closes every file without edit, then a second launch on the same copy that
// edits one paragraph of each editable file, compared to its bytes before that
// second launch. A pass counts only when both launches complete.
describe("AT-01 pass: two launches on one copy (PROTOCOL.md section 10.5)", () => {
  test("the edit launch runs after the round trip, on the same copy, and a pass gives both lines", async () => {
    const record = recorder();
    const series = await at01Series(2, true, steps(record, {}), [], new Streak());
    expect(record.copies).toBe(2);
    expect(record.disposed).toBe(2);
    const [copy, roundTrip, edit] = record.log;
    const vault = copy?.slice("copy:".length);
    expect(roundTrip).toBe(`round-trip:${vault}:3:at-01 pass 0`);
    expect(edit).toBe(`edit:${vault}:at-01 pass 0`);
    expect(series.roundTrip).toEqual([
      { examined: 3, identical: 3, changed: 0, missing: 0, added: 0 },
      { examined: 3, identical: 3, changed: 0, missing: 0, added: 0 },
    ]);
    expect(series.editableFiles).toBe(2);
    expect(series.edit).toEqual([
      { expected: 2, examined: 2, conforming: 2, unexpectedChanges: 0 },
      { expected: 2, examined: 2, conforming: 2, unexpectedChanges: 0 },
    ]);
  });

  test("the edit is compared to the bytes before the second launch, not to the fresh copy", async () => {
    const record = recorder();
    // The round trip changes the file that is not editable: the round-trip line sees
    // it; the edit line, which compares to the bytes before its own launch, does not.
    const series = await at01Series(
      1,
      true,
      steps(record, { roundTrip: (vault) => write(vault, "notes/c.bin", new Uint8Array([0x00])) }),
      [],
      new Streak(),
    );
    expect(series.roundTrip).toEqual([
      { examined: 3, identical: 2, changed: 1, missing: 0, added: 0 },
    ]);
    expect(series.edit).toEqual([
      { expected: 2, examined: 2, conforming: 2, unexpectedChanges: 0 },
    ]);
  });

  test("a pass whose edit launch is interrupted is recorded, not counted, and redone from a fresh copy", async () => {
    const record = recorder();
    const interruptions: Interruption[] = [];
    const series = await at01Series(
      1,
      true,
      steps(record, {
        edit: (vault, plan, attempt) => {
          if (attempt === 1) throw new Interrupted("page-hidden", "window hidden");
          editAsPlanned(vault, plan);
        },
      }),
      interruptions,
      new Streak(),
    );
    expect(interruptions).toEqual([
      { unit: "at-01 pass 0", attempt: 1, cause: "page-hidden", reason: "window hidden" },
    ]);
    expect(record.copies).toBe(2);
    expect(record.disposed).toBe(2);
    expect(series.roundTrip).toHaveLength(1);
    expect(series.edit).toHaveLength(1);
  });

  test("without the edit (a trial of the round trip alone), no edit launch is made", async () => {
    const record = recorder();
    const series = await at01Series(1, false, steps(record, {}), [], new Streak());
    expect(record.log.some((line) => line.startsWith("edit:"))).toBe(false);
    expect(series.edit).toEqual([]);
    expect(series.roundTrip).toHaveLength(1);
  });

  test("an unavailable launch ends the series of passes, it is not redone", async () => {
    const record = recorder();
    const run = at01Series(
      2,
      true,
      steps(record, {
        edit: () => {
          throw new Unavailable("AXIsProcessTrusted() is false");
        },
      }),
      [],
      new Streak(),
    );
    await expect(run).rejects.toBeInstanceOf(Unavailable);
    expect(record.copies).toBe(1);
    expect(record.disposed).toBe(1);
  });
});
