// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The listener of `vault_changed` (CA-47). The shell emits the event after each
// successful `write_note`; the capability lets the front listen to it and do
// nothing else with events (`core:event:allow-listen` only: no emit, no
// unlisten). The transport is injected like the one of the client: the editor
// package hands it the `listen` of `@tauri-apps/api/event`, a test hands it a
// recorder.

import { type NoteWritten, VAULT_CHANGED_EVENT } from "./contract";

/** The shape of `listen` in `@tauri-apps/api/event`, reduced to what is used here. */
export type Listen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<unknown>;

const REVISION_FORMAT = /^[0-9a-f]{64}$/;

/** The payload the shell emits: the path and the new revision, nothing else is trusted. */
function asChange(payload: unknown): NoteWritten | null {
  if (payload === null || typeof payload !== "object") return null;
  const { path, revision } = payload as Record<string, unknown>;
  if (typeof path !== "string" || typeof revision !== "string") return null;
  return REVISION_FORMAT.test(revision) ? { path, revision } : null;
}

/**
 * Calls `handler` for each `vault_changed` the shell emits. A payload that is
 * not the declared shape is dropped, not forwarded. The listener lives as long
 * as the page: the capability grants no `unlisten`, so none is offered.
 */
export async function onVaultChanged(
  listen: Listen,
  handler: (change: NoteWritten) => void,
): Promise<void> {
  await listen(VAULT_CHANGED_EVENT, (event) => {
    const change = asChange(event.payload);
    if (change !== null) handler(change);
  });
}
