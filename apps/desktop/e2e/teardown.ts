// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// Removes the scratch folder of the run: the stand-in home folder and the vault
// under it. Only a folder this run made (below the system temporary folder,
// named `p04-e2e-*`) is ever removed.

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, sep } from "node:path";

export default function teardown(): void {
  const vault = process.env.P04_E2E_VAULT;
  if (vault === undefined) return;
  const home = dirname(resolve(vault));
  const inTemp = home.startsWith(resolve(tmpdir()) + sep) || home.startsWith(`/private${tmpdir()}`);
  if (inTemp && basename(home).startsWith("p04-e2e-")) {
    rmSync(home, { recursive: true, force: true });
  }
}
