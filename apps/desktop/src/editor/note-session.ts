// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// One open note: what was read, the revision it was read at, and the saves of
// the edits that follow. It holds no DOM and no CodeMirror, so that its rules
// are tested without a browser. The text is turned into bytes by the standard
// encoder and back by a strict decoder: a note that is not UTF-8, or a buffer
// that has no UTF-8 form, is refused rather than saved with replacement
// characters in it (CA-41 forbids changing a character nobody typed).
//
// Saves are serial and carry the revision of the previous one. A revision
// conflict, or a `vault_changed` of this note that the session did not write,
// stops the saves: the note is not overwritten behind someone else's change.

import { type Bridge, BridgeRefusal, type NoteWritten } from "../bridge";

export type SaveState =
  /** Nothing typed since the note was loaded. */
  | "idle"
  /** Typed, not yet written. */
  | "dirty"
  | "saving"
  | "saved"
  /** The note changed under the session: saves stopped, nothing was overwritten. */
  | "conflict"
  /** The buffer has no UTF-8 form: saves stopped until it has. */
  | "refused"
  /** The write failed (not a conflict): the next edit tries again. */
  | "failed";

export interface Timers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface SessionOptions {
  readonly debounceMs?: number;
  readonly timers?: Timers;
}

/** The note on disk is not UTF-8: the editor does not open it. */
export class NotUtf8 extends Error {
  constructor() {
    super("note.not_utf8");
    this.name = "NotUtf8";
  }
}

const browserTimers: Timers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class NoteSession {
  readonly path: string;
  readonly #bridge: Pick<Bridge, "readNote" | "writeNote">;
  readonly #debounceMs: number;
  readonly #timers: Timers;
  readonly #listeners = new Set<(state: SaveState) => void>();
  /** Revisions this session wrote: a `vault_changed` that carries one is our own write coming back. */
  readonly #own = new Set<string>();
  #state: SaveState = "idle";
  #revision: string | null = null;
  #saved: string | null = null;
  #latest: string | null = null;
  #timer: unknown;
  #saving: Promise<void> | null = null;
  #heard: string[] = [];

  constructor(
    bridge: Pick<Bridge, "readNote" | "writeNote">,
    path: string,
    options: SessionOptions = {},
  ) {
    this.#bridge = bridge;
    this.path = path;
    this.#debounceMs = options.debounceMs ?? 400;
    this.#timers = options.timers ?? browserTimers;
  }

  get state(): SaveState {
    return this.#state;
  }

  /** The revision the next write expects; `null` while the note does not exist. */
  get revision(): string | null {
    return this.#revision;
  }

  onState(listener: (state: SaveState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #set(state: SaveState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener(state);
  }

  /**
   * Reads the note. A note that does not exist is an empty one that the first
   * save creates; a note that is not UTF-8 throws `NotUtf8` and nothing is kept.
   */
  async load(): Promise<{ text: string; created: boolean }> {
    try {
      const note = await this.#bridge.readNote(this.path);
      // `ignoreBOM: true` keeps a leading U+FEFF in the text instead of dropping it.
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(note.bytes);
      } catch {
        throw new NotUtf8();
      }
      this.#revision = note.revision;
      this.#saved = text;
      this.#latest = text;
      return { text, created: false };
    } catch (failure) {
      if (failure instanceof BridgeRefusal && failure.code === "vault.not_found") {
        this.#revision = null;
        this.#saved = "";
        this.#latest = "";
        return { text: "", created: true };
      }
      throw failure;
    }
  }

  /** The buffer changed. The write follows after the pause in typing. */
  edit(text: string): void {
    this.#latest = text;
    if (this.#state === "conflict") return;
    if (this.#state !== "saving") {
      this.#set(text === this.#saved ? (this.#own.size > 0 ? "saved" : "idle") : "dirty");
    }
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = this.#timers.set(() => void this.flush(), this.#debounceMs);
  }

  /** Writes what is pending, now. Resolves when nothing is left to write or the saves stopped. */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      this.#timers.clear(this.#timer);
      this.#timer = undefined;
    }
    do {
      this.#saving ??= this.#drain().finally(() => {
        this.#saving = null;
      });
      await this.#saving;
    } while (this.#pending() && !["conflict", "refused", "failed"].includes(this.#state));
  }

  #pending(): boolean {
    return this.#latest !== null && this.#latest !== this.#saved;
  }

  async #drain(): Promise<void> {
    if (this.#state === "conflict") return;
    while (this.#pending()) {
      const text = this.#latest;
      if (text === null) return;
      if (!text.isWellFormed()) {
        this.#set("refused");
        return;
      }
      this.#set("saving");
      this.#heard = [];
      let written: NoteWritten;
      try {
        written = await this.#bridge.writeNote(
          this.path,
          new TextEncoder().encode(text),
          this.#revision,
        );
      } catch (failure) {
        this.#set(
          failure instanceof BridgeRefusal && failure.code === "vault.revision_conflict"
            ? "conflict"
            : "failed",
        );
        return;
      }
      this.#revision = written.revision;
      this.#saved = text;
      this.#own.add(written.revision);
      // A change of this note announced while we wrote, and that is none of our writes.
      if (this.#heard.some((revision) => !this.#own.has(revision))) {
        this.#set("conflict");
        return;
      }
    }
    this.#set(this.#pending() ? "dirty" : "saved");
  }

  /** A `vault_changed` of the shell. Our own writes are recognised by their revision. */
  noteChanged(change: NoteWritten): void {
    if (change.path !== this.path) return;
    if (this.#state === "saving") {
      this.#heard.push(change.revision);
    } else if (!this.#own.has(change.revision) && change.revision !== this.#revision) {
      this.#set("conflict");
    }
  }
}
