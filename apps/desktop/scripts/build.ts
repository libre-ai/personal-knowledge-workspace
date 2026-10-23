// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// Produces `dist/`, the folder Tauri embeds (`build.frontendDist`). The shell
// of this work package serves a static page; the editor bundle joins it in the
// editor work package, so the build is a copy until then.

import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyFileSync(join(root, "index.html"), join(dist, "index.html"));
console.log("build: 1 file copied to apps/desktop/dist");
