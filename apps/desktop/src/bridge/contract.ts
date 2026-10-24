// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The wire contract of the vault bridge (CA-39), as the front sees it. The Rust
// side (`apps/desktop/src-tauri/src/bridge.rs`) owns every behaviour; this file
// only names what crosses. `tests/bridge/wire.v1.json` is read by the tests of
// both sides, so a name changed on one side and not the other turns a test red.

export const BRIDGE_COMMANDS = [
  "choose_vault",
  "read_note",
  "write_note",
  "render_preview",
  "search",
  "rebuild_index",
] as const;

export type BridgeCommand = (typeof BRIDGE_COMMANDS)[number];

export const PATH_HEADER = "x-vault-path";
export const REVISION_HEADER = "x-vault-revision";

/** Event emitted by the shell after a successful `write_note`. */
export const VAULT_CHANGED_EVENT = "vault_changed";

/** `read_note` answers 64 ASCII hexadecimal digits (the revision), then the exact bytes of the file. */
export const READ_FRAME_PREFIX_BYTES = 64;

/** The closed list of refusals. A rejection that is not one of these is not a refusal of the vault. */
export const REFUSAL_CODES = [
  "vault.invalid_vault",
  "vault.invalid_path",
  "vault.not_found",
  "vault.revision_conflict",
  "vault.invalid_revision",
  "vault.too_large",
  "vault.not_utf8",
  "vault.invalid_query",
  "vault.index_missing",
  "vault.io",
  "vault.not_open",
  "vault.invalid_request",
  "vault.already_open",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type NodeKind =
  | "document"
  | "paragraph"
  | "heading"
  | "block_quote"
  | "code_block"
  | "list"
  | "list_item"
  | "emphasis"
  | "strong"
  | "strikethrough"
  | "code"
  | "link"
  | "wiki_link"
  | "image"
  | "rule"
  | "html"
  | "frontmatter"
  | "table"
  | "table_head"
  | "table_row"
  | "table_cell"
  | "other";

/**
 * A range of the note with its attributes, never markup. `from` and `to` are
 * UTF-16 code-unit offsets into the text exactly as the front holds it (a
 * leading U+FEFF counts as one unit), the unit of CodeMirror positions.
 */
export interface PreviewNode {
  kind: NodeKind;
  from: number;
  to: number;
  level?: number;
  language?: string;
  ordered?: boolean;
  start?: number;
  checked?: boolean;
  /** A link or image destination that passed the shell's whitelist. */
  url?: string;
  /** The note a wiki link names. */
  target?: string;
  /** The destination failed the whitelist and was dropped by the shell. */
  blocked?: boolean;
  children: PreviewNode[];
}

export interface NoteRead {
  /** SHA-256 of `bytes`, 64 lowercase hexadecimal digits. */
  revision: string;
  bytes: Uint8Array;
}

export interface NoteWritten {
  path: string;
  revision: string;
}

export interface SearchHit {
  path: string;
  score: number;
}

export interface IndexStats {
  notes: number;
  ignored: number;
  unreadable: number;
  terms: number;
}
