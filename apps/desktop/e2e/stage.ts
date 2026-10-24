// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// Stages the site the harness serves: the production front exactly as built into
// `dist/` (the folder Tauri embeds), in a folder of its own, `e2e/dist/`, which
// git ignores. The test page `substituting.html` is bundled into the same folder
// by `build:e2e` after this step. Nothing of `e2e/` is ever copied into `dist/`.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const app = join(import.meta.dir, "..");
const dist = join(app, "dist");
const site = join(app, "e2e", "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.error("stage FAILED: apps/desktop/dist/index.html is missing: run `bun run build`");
  process.exit(1);
}
rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
cpSync(dist, site, { recursive: true });
console.log(`stage: ${readdirSync(site).length} file(s) of dist/ copied to apps/desktop/e2e/dist`);
