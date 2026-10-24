// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-41, the part that needs no browser: what a note session reads and writes.
// The bytes it sends are the UTF-8 of the text it was given, a note that is not
// UTF-8 or a buffer that has no UTF-8 form is refused, saves are serial and carry
// the revision of the previous one, and a note changed elsewhere is never
// overwritten.

import { describe, expect, test } from "bun:test";

import { type Bridge, BridgeRefusal, type NoteRead, type NoteWritten } from "../../src/bridge";
import { NoteSession, NotUtf8, type SaveState, type Timers } from "../../src/editor/note-session";

const hex = (digit: string): string => digit.repeat(64);

class ManualTimers implements Timers {
  readonly pending = new Map<number, () => void>();
  #next = 1;

  set(callback: () => void): number {
    const handle = this.#next++;
    this.pending.set(handle, callback);
    return handle;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Fires every pending timer once, as the pause in typing elapsing would. */
  fire(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }
}

interface Write {
  path: string;
  bytes: Uint8Array;
  expected: string | null;
}

function fakeBridge(options: { note?: Uint8Array | "absent"; writes?: Write[] } = {}) {
  const writes = options.writes ?? [];
  let counter = 0;
  const gates: Array<() => void> = [];
  let hold = false;
  let failWith: BridgeRefusal | Error | null = null;
  const bridge: Pick<Bridge, "readNote" | "writeNote"> = {
    async readNote(): Promise<NoteRead> {
      if (options.note === "absent" || options.note === undefined) {
        throw new BridgeRefusal("vault.not_found");
      }
      return { revision: hex("0"), bytes: options.note };
    },
    async writeNote(path, bytes, expected): Promise<NoteWritten> {
      writes.push({ path, bytes: bytes.slice(), expected });
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      if (failWith !== null) throw failWith;
      counter += 1;
      return { path, revision: hex(String(counter)) };
    },
  };
  return {
    bridge,
    writes,
    holdWrites: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      for (const gate of gates.splice(0)) gate();
    },
    failNextWrites: (failure: BridgeRefusal | Error | null) => {
      failWith = failure;
    },
  };
}

function states(session: NoteSession): SaveState[] {
  const seen: SaveState[] = [];
  session.onState((state) => seen.push(state));
  return seen;
}

describe("reading", () => {
  test("a note is decoded without changing a character, a BOM and CRLF included", async () => {
    const text = "﻿café café\r\nline two\r\n\u{1F600}\t \n";
    const { bridge } = fakeBridge({ note: new TextEncoder().encode(text) });
    const session = new NoteSession(bridge, "a.md");
    expect(await session.load()).toEqual({ text, created: false });
    expect(session.revision).toBe(hex("0"));
  });

  test("a note that does not exist opens empty and is created by the first save", async () => {
    const { bridge, writes } = fakeBridge({ note: "absent" });
    const timers = new ManualTimers();
    const session = new NoteSession(bridge, "new.md", { timers });
    expect(await session.load()).toEqual({ text: "", created: true });
    expect(session.revision).toBeNull();
    session.edit("x");
    await session.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expected).toBeNull();
  });

  test("a note that is not UTF-8 is not opened", async () => {
    const { bridge } = fakeBridge({ note: new Uint8Array([0x61, 0xff, 0xfe, 0x62]) });
    const session = new NoteSession(bridge, "bin.md");
    await expect(session.load()).rejects.toBeInstanceOf(NotUtf8);
    expect(session.revision).toBeNull();
  });

  test("any other refusal of the shell is passed on", async () => {
    const bridge: Pick<Bridge, "readNote" | "writeNote"> = {
      async readNote() {
        throw new BridgeRefusal("vault.not_open");
      },
      async writeNote() {
        throw new Error("unused");
      },
    };
    await expect(new NoteSession(bridge, "a.md").load()).rejects.toMatchObject({
      code: "vault.not_open",
    });
  });
});

describe("writing", () => {
  const TYPED =
    'He said "hi" -- wait... see https://example.test/a?b=1&c=2  two  spaces, teh mispelled word, jane.doe@example.test\n';

  test("the bytes sent are the UTF-8 of the text, character for character", async () => {
    const { bridge, writes } = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    session.edit(TYPED);
    await session.flush();
    expect(writes).toHaveLength(1);
    expect(new TextDecoder().decode(writes[0]?.bytes)).toBe(TYPED);
    expect([...(writes[0]?.bytes ?? [])]).toEqual([...new TextEncoder().encode(TYPED)]);
  });

  test("the pause in typing writes once, with the revision that was read", async () => {
    const { bridge, writes } = fakeBridge({ note: new TextEncoder().encode("a") });
    const timers = new ManualTimers();
    const session = new NoteSession(bridge, "a.md", { timers });
    await session.load();
    for (const text of ["ab", "abc", "abcd"]) session.edit(text);
    expect(timers.pending.size).toBe(1);
    expect(writes).toHaveLength(0);
    timers.fire();
    await session.flush();
    expect(writes.map((write) => [new TextDecoder().decode(write.bytes), write.expected])).toEqual([
      ["abcd", hex("0")],
    ]);
    expect(session.state).toBe("saved");
  });

  test("saves are serial: a second write waits for the first and carries its revision", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("a") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    control.holdWrites();
    session.edit("ab");
    const first = session.flush();
    await Promise.resolve();
    expect(control.writes).toHaveLength(1);
    session.edit("abc");
    const second = session.flush();
    await Promise.resolve();
    expect(control.writes).toHaveLength(1);
    control.release();
    await Promise.all([first, second]);
    expect(
      control.writes.map((write) => [new TextDecoder().decode(write.bytes), write.expected]),
    ).toEqual([
      ["ab", hex("0")],
      ["abc", hex("1")],
    ]);
    expect(session.state).toBe("saved");
  });

  test("typing back to the saved text writes nothing", async () => {
    const { bridge, writes } = fakeBridge({ note: new TextEncoder().encode("a") });
    const session = new NoteSession(bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    session.edit("ab");
    session.edit("a");
    await session.flush();
    expect(writes).toHaveLength(0);
    // Nothing differs from the note on disk: there is nothing unsaved.
    expect(session.state).toBe("saved");
  });

  test("a buffer with a lone surrogate is refused, never written with a replacement character", async () => {
    const { bridge, writes } = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    session.edit("ok \ud800 not ok");
    await session.flush();
    expect(writes).toHaveLength(0);
    expect(session.state).toBe("refused");
    // Once the buffer has a UTF-8 form again, the saves resume.
    session.edit("ok");
    await session.flush();
    expect(writes).toHaveLength(1);
    expect(session.state).toBe("saved");
  });

  test("a failed write is retried at the next change", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    control.failNextWrites(new BridgeRefusal("vault.io"));
    session.edit("a");
    await session.flush();
    expect(session.state).toBe("failed");
    control.failNextWrites(null);
    session.edit("ab");
    await session.flush();
    expect(session.state).toBe("saved");
    expect(control.writes).toHaveLength(2);
  });
});

describe("a note changed elsewhere is not overwritten", () => {
  test("a revision conflict stops the saves", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    control.failNextWrites(new BridgeRefusal("vault.revision_conflict"));
    session.edit("mine");
    await session.flush();
    expect(session.state).toBe("conflict");
    control.failNextWrites(null);
    session.edit("mine, more");
    await session.flush();
    expect(session.state).toBe("conflict");
    expect(control.writes).toHaveLength(1);
  });

  test("a vault_changed of this note with a revision that is not ours stops the saves", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    session.noteChanged({ path: "a.md", revision: hex("e") });
    expect(session.state).toBe("conflict");
    session.edit("mine");
    await session.flush();
    expect(control.writes).toHaveLength(0);
  });

  test("a vault_changed of another note, or of our own write, changes nothing", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    const seen = states(session);
    session.noteChanged({ path: "other.md", revision: hex("e") });
    session.edit("mine");
    await session.flush();
    // The shell announces the write after it is done, or before the answer arrives.
    session.noteChanged({ path: "a.md", revision: hex("1") });
    expect(session.state).toBe("saved");
    expect(seen).not.toContain("conflict");
  });

  test("an event of our own write that arrives before the answer is not a conflict", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    control.holdWrites();
    session.edit("mine");
    const flushed = session.flush();
    await Promise.resolve();
    session.noteChanged({ path: "a.md", revision: hex("1") });
    control.release();
    await flushed;
    expect(session.state).toBe("saved");
  });

  test("an event of a foreign write that arrives while we write is a conflict", async () => {
    const control = fakeBridge({ note: new TextEncoder().encode("") });
    const session = new NoteSession(control.bridge, "a.md", { timers: new ManualTimers() });
    await session.load();
    control.holdWrites();
    session.edit("mine");
    const flushed = session.flush();
    await Promise.resolve();
    session.noteChanged({ path: "a.md", revision: hex("e") });
    control.release();
    await flushed;
    expect(session.state).toBe("conflict");
  });
});
