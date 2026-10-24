// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The client of the vault bridge. It forwards six calls to the Rust shell and
// shapes their answers; it reads no file, analyses no Markdown and holds no
// index (CA-40). The transport is injected: the editor package hands it the
// `invoke` of `@tauri-apps/api/core`, a test hands it a recorder.

import {
  type IndexStats,
  type NoteRead,
  type NoteWritten,
  PATH_HEADER,
  type PreviewNode,
  READ_FRAME_PREFIX_BYTES,
  REFUSAL_CODES,
  REVISION_HEADER,
  type RefusalCode,
  type SearchHit,
} from "./contract";

export interface InvokeOptions {
  headers?: Record<string, string>;
}

/** The shape of `invoke` in `@tauri-apps/api/core`. A raw body is a `Uint8Array`; a raw answer is an `ArrayBuffer`. */
export type Invoke = (
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: InvokeOptions,
) => Promise<unknown>;

/** The shell refused with one of its closed `vault.*` codes. */
export class BridgeRefusal extends Error {
  readonly code: RefusalCode;

  constructor(code: RefusalCode) {
    super(code);
    this.name = "BridgeRefusal";
    this.code = code;
  }
}

/**
 * Anything else that goes wrong: the transport refused the command (not in the
 * capability), or an answer is not the shape the contract says. The message is
 * fixed on purpose: nothing the shell or the transport said is repeated.
 */
export class BridgeFailure extends Error {
  constructor() {
    super("bridge.failure");
    this.name = "BridgeFailure";
  }
}

const REVISION_FORMAT = /^[0-9a-f]{64}$/;

function isRefusalCode(value: unknown): value is RefusalCode {
  return typeof value === "string" && (REFUSAL_CODES as readonly string[]).includes(value);
}

async function send(
  invoke: Invoke,
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: InvokeOptions,
): Promise<unknown> {
  try {
    return await invoke(command, args, options);
  } catch (rejection) {
    throw isRefusalCode(rejection) ? new BridgeRefusal(rejection) : new BridgeFailure();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new BridgeFailure();
}

function asRevision(value: unknown): string {
  if (typeof value !== "string" || !REVISION_FORMAT.test(value)) throw new BridgeFailure();
  return value;
}

function asWritten(value: unknown): NoteWritten {
  if (!isRecord(value) || typeof value.path !== "string") throw new BridgeFailure();
  return { path: value.path, revision: asRevision(value.revision) };
}

function asHits(value: unknown): SearchHit[] {
  if (!Array.isArray(value)) throw new BridgeFailure();
  return value.map((hit: unknown) => {
    if (!isRecord(hit) || typeof hit.path !== "string" || typeof hit.score !== "number") {
      throw new BridgeFailure();
    }
    return { path: hit.path, score: hit.score };
  });
}

function asStats(value: unknown): IndexStats {
  if (
    !isRecord(value) ||
    typeof value.notes !== "number" ||
    typeof value.ignored !== "number" ||
    typeof value.unreadable !== "number" ||
    typeof value.terms !== "number"
  ) {
    throw new BridgeFailure();
  }
  return {
    notes: value.notes,
    ignored: value.ignored,
    unreadable: value.unreadable,
    terms: value.terms,
  };
}

function asTree(value: unknown): PreviewNode {
  if (!isRecord(value) || value.kind !== "document" || !Array.isArray(value.children)) {
    throw new BridgeFailure();
  }
  // The shell builds this tree from a closed set of kinds and attributes: it is
  // typed here, not re-validated node by node.
  return value as unknown as PreviewNode;
}

/** The path travels in a header: percent-encoded UTF-8, which the shell decodes strictly. */
function encodePath(path: string): string {
  try {
    return encodeURIComponent(path);
  } catch {
    // A lone surrogate has no UTF-8 form: no note can have this name.
    throw new BridgeRefusal("vault.invalid_path");
  }
}

export interface Bridge {
  /** Opens the folder (an absolute path) as the vault; replaces the previous one. */
  openVault(path: string): Promise<void>;
  /** The exact bytes of the note and their revision. */
  readNote(path: string): Promise<NoteRead>;
  /**
   * Writes exactly `bytes`. `expectedRevision` is the revision read before the
   * edit, or `null` to create a note that must not exist yet.
   */
  writeNote(path: string, bytes: Uint8Array, expectedRevision: string | null): Promise<NoteWritten>;
  /** The attribute tree of the preview of `markdown` (UTF-8 bytes of the editor buffer). */
  renderPreview(markdown: Uint8Array): Promise<PreviewNode>;
  search(query: string): Promise<SearchHit[]>;
  rebuildIndex(): Promise<IndexStats>;
}

export function createBridge(invoke: Invoke): Bridge {
  return {
    async openVault(path) {
      await send(invoke, "open_vault", { path });
    },

    async readNote(path) {
      const frame = asBytes(await send(invoke, "read_note", { path }));
      if (frame.length < READ_FRAME_PREFIX_BYTES) throw new BridgeFailure();
      const revision = asRevision(
        new TextDecoder().decode(frame.subarray(0, READ_FRAME_PREFIX_BYTES)),
      );
      return { revision, bytes: frame.subarray(READ_FRAME_PREFIX_BYTES) };
    },

    async writeNote(path, bytes, expectedRevision) {
      const headers: Record<string, string> = { [PATH_HEADER]: encodePath(path) };
      if (expectedRevision !== null) headers[REVISION_HEADER] = expectedRevision;
      return asWritten(await send(invoke, "write_note", bytes, { headers }));
    },

    async renderPreview(markdown) {
      return asTree(await send(invoke, "render_preview", markdown));
    },

    async search(query) {
      return asHits(await send(invoke, "search", { query }));
    },

    async rebuildIndex() {
      return asStats(await send(invoke, "rebuild_index", {}));
    },
  };
}
