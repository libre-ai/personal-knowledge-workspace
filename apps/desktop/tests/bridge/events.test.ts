// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-47: the front listens to `vault_changed` and forwards only the declared
// payload. The permission that makes it possible is judged by
// `tests/shell/config.test.ts` and, against the real ACL, by the Rust test
// `bridge_the_front_may_listen_to_events_and_do_nothing_else_with_them`.

import { describe, expect, test } from "bun:test";

import { type Listen, onVaultChanged, VAULT_CHANGED_EVENT } from "../../src/bridge";

const REVISION = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function emitter(): {
  listen: Listen;
  emit: (payload: unknown) => void;
  listened: string[];
} {
  const handlers: Array<(event: { payload: unknown }) => void> = [];
  const listened: string[] = [];
  const listen: Listen = async (event, handler) => {
    listened.push(event);
    handlers.push(handler);
    return () => undefined;
  };
  return {
    listen,
    listened,
    emit: (payload) => {
      for (const handler of handlers) handler({ payload });
    },
  };
}

describe("onVaultChanged", () => {
  test("listens to the event of the wire contract and nothing else", async () => {
    const { listen, listened } = emitter();
    await onVaultChanged(listen, () => undefined);
    expect(listened).toEqual([VAULT_CHANGED_EVENT]);
  });

  test("forwards the path and the revision the shell emits", async () => {
    const { listen, emit } = emitter();
    const seen: unknown[] = [];
    await onVaultChanged(listen, (change) => seen.push(change));
    emit({ path: "notes/a.md", revision: REVISION });
    expect(seen).toEqual([{ path: "notes/a.md", revision: REVISION }]);
  });

  test("drops every payload that is not the declared shape", async () => {
    const { listen, emit } = emitter();
    const seen: unknown[] = [];
    await onVaultChanged(listen, (change) => seen.push(change));
    const malformed: unknown[] = [
      null,
      undefined,
      "notes/a.md",
      42,
      {},
      { path: "a.md" },
      { revision: REVISION },
      { path: 7, revision: REVISION },
      { path: "a.md", revision: 7 },
      { path: "a.md", revision: "not-a-revision" },
      { path: "a.md", revision: REVISION.toUpperCase() },
      { path: "a.md", revision: `${REVISION}0` },
    ];
    for (const payload of malformed) emit(payload);
    expect(seen).toEqual([]);
    console.log(`vault_changed: ${malformed.length} malformed payloads dropped`);
  });

  test("forwards only path and revision of a payload that carries more", async () => {
    const { listen, emit } = emitter();
    const seen: unknown[] = [];
    await onVaultChanged(listen, (change) => seen.push(change));
    emit({ path: "a.md", revision: REVISION, root: "/Users/x/notes" });
    expect(seen).toEqual([{ path: "a.md", revision: REVISION }]);
  });
});
