// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-41: the editor in Playwright WebKit. The web server is the e2e harness
// (`src-tauri/src/bin/e2e_harness.rs`): the production front over HTTP, its IPC
// relayed to the real bridge of the shell on the mock runtime. The vault is a
// scratch folder below a scratch "home" made here, once, for the whole run.

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const PORT = 4175;

// The runner makes the vault; the workers it starts inherit the variable.
if (process.env.P04_E2E_VAULT === undefined) {
  const home = mkdtempSync(join(tmpdir(), "p04-e2e-"));
  const vault = join(home, "vault");
  mkdirSync(vault);
  process.env.P04_E2E_VAULT = vault;
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  globalTeardown: "./e2e/teardown.ts",
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `bun run build:e2e && cargo run --locked -p libre-ai-p04-desktop --features e2e-harness --bin e2e-harness -- --port ${PORT} --assets e2e/dist --vault "$P04_E2E_VAULT"`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 600_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
