// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
/// <reference lib="dom" />
//
// The one link of the real path that the Playwright run replaces: the IPC of the
// shell. In the shell, `@tauri-apps/api` reaches the Rust process through
// `window.__TAURI_INTERNALS__`, which the WKWebView provides. Here this function
// provides it, and relays each call to the harness (`src/bin/e2e_harness.rs`),
// which runs it through the real bridge. The production bundle is unchanged and
// calls `invoke` and `listen` of `@tauri-apps/api` as it does in the shell.
//
// The function is serialised by Playwright (`page.addInitScript`): it must not
// use anything from its module scope. Every call is also logged on
// `window.__ipcLog`, the bytes of a raw body included, so that a test can say
// what `write_note` was given. Events are not delivered into the page (the mock
// runtime has no webview to deliver them to); see the e2e report.

export interface IpcLogEntry {
  command: string;
  headers: Record<string, string>;
  /** The raw body, byte for byte; `null` for a JSON call. */
  bytes: number[] | null;
  json: unknown;
  ok: boolean;
}

export function installTauriShim(): void {
  const w = window as unknown as Record<string, unknown>;
  const log: IpcLogEntry[] = [];
  w.__ipcLog = log;
  const violations: string[] = [];
  w.__cspViolations = violations;
  document.addEventListener("securitypolicyviolation", (event) => {
    violations.push(`${event.violatedDirective} ${event.blockedURI}`);
  });

  let nextCallback = 1;
  w.__TAURI_INTERNALS__ = {
    transformCallback(): number {
      nextCallback += 1;
      return nextCallback;
    },
    unregisterCallback(): void {},
    convertFileSrc(path: string): string {
      return path;
    },
    async invoke(
      command: string,
      args?: unknown,
      options?: { headers?: Record<string, string> },
    ): Promise<unknown> {
      const headers: Record<string, string> = { ...(options?.headers ?? {}) };
      const raw = args instanceof Uint8Array || args instanceof ArrayBuffer;
      let body: BodyInit;
      let sent: Uint8Array | null = null;
      if (raw) {
        sent = args instanceof ArrayBuffer ? new Uint8Array(args) : (args as Uint8Array);
        // A Blob carries the bytes as they are; the content type is set below.
        body = new Blob([sent as unknown as BlobPart]);
        headers["content-type"] = "application/octet-stream";
      } else {
        body = JSON.stringify(args ?? {});
        headers["content-type"] = "application/json";
      }
      const entry: IpcLogEntry = {
        command,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([name]) => name !== "content-type"),
        ),
        bytes: sent === null ? null : Array.from(sent),
        json: raw ? null : (args ?? {}),
        ok: false,
      };
      log.push(entry);
      const response = await fetch(`/ipc/${encodeURIComponent(command)}`, {
        method: "POST",
        headers,
        body,
      });
      entry.ok = response.ok;
      if (!response.ok) throw await response.json();
      const type = response.headers.get("content-type") ?? "";
      return type.startsWith("application/octet-stream")
        ? await response.arrayBuffer()
        : await response.json();
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(): void {} };
}
