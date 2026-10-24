// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The only place the front reaches the native side: the `invoke` and `listen`
// of `@tauri-apps/api` handed to the client and to the listener of
// `vault_changed`. Everything else in `src/` goes through `Bridge` (CA-40).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { type Bridge, createBridge } from "./client";
import { type Listen, onVaultChanged } from "./events";

/** The bridge of the vault over the IPC of the shell. */
export function tauriBridge(): Bridge {
  // Tauri requires `headers` whenever options are given; the client leaves them out for a JSON call.
  return createBridge((command, args, options) =>
    invoke(
      command,
      args,
      options?.headers === undefined ? undefined : { headers: options.headers },
    ),
  );
}

/** The listener of `vault_changed` over the event system of the shell. */
export const tauriListen: Listen = (event, handler) => listen<unknown>(event, handler);

export { onVaultChanged };
