// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Command line of run.ts:
//
//   bun tools/qualification/p04-tauri/series/run.ts --out DIR [--trial N] [--only ID,ID] [--binary PATH]

import { resolve } from "node:path";

export interface Options {
  out: string;
  /** Caps every count at N. */
  trial: number | null;
  /** Measure ids to make, the others are skipped. */
  only: string[] | null;
  /** A binary to measure instead of the one built from the commit. */
  binary: string | null;
}

export function parseOptions(argv: readonly string[]): Options {
  const parsed: Options = { out: "", trial: null, only: null, binary: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${String(name)} needs a value`);
    if (name === "--out") parsed.out = resolve(value);
    else if (name === "--trial" && /^[1-9][0-9]*$/.test(value)) parsed.trial = Number(value);
    else if (name === "--only") parsed.only = value.split(",");
    else if (name === "--binary") parsed.binary = resolve(value);
    else throw new Error(`unknown option ${String(name)}`);
  }
  if (parsed.out === "") throw new Error("--out DIR is required");
  return parsed;
}

/**
 * A trial tunes the harness and is never a report: the manifest says
 * `trial: true` and check-report.ts refuses it. Capped counts and a subset of
 * measures are trials; so is a binary passed by `--binary`, which is not the one
 * built from the commit the manifest names.
 */
export function isTrial(options: Options): boolean {
  return options.trial !== null || options.only !== null || options.binary !== null;
}
