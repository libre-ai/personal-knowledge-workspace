// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// First step of `check:p04-shell`, before any cargo step. `build.rs` refuses the
// variables that rewrite the configuration (TAURI_CONFIG: `tauri-build` merges it
// into the configuration), so a chain started under one would fail at its first
// build. This step fails earlier and says why: the shell must be built from the
// files that `config.test.ts` read, or the static and dynamic halves judge
// different shells.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { refusedEnvironment } from "./controls";

const buildScript = readFileSync(
  join(import.meta.dir, "..", "..", "src-tauri", "build.rs"),
  "utf8",
);
const refused = refusedEnvironment(buildScript);
if (refused.length === 0) {
  // An empty list would read as "nothing to refuse" and pass.
  console.error("refuse-env FAILED: build.rs declares no refused variable (REFUSED_ENV)");
  process.exit(1);
}

const defined = refused.filter((name) => process.env[name] !== undefined);
if (defined.length > 0) {
  console.error(
    `refuse-env FAILED: ${defined.join(", ")} defined. Tauri merges it into the configuration at build time, so the shell would not be built from the files the static gate read (controls C2 to C5). Unset it and rerun.`,
  );
  process.exit(1);
}
console.log(`refuse-env: ${refused.length} variable(s) refused (${refused.join(", ")}), 0 defined`);
