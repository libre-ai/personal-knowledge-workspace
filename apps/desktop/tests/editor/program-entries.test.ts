// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// `program.ts` is what puts the e2e files in the program `tsc` reads (the
// tsconfig of the app includes `scripts/` and `tests/` only): an e2e file that it
// does not list is never typechecked, and a type error in it passes
// `check:p04-editor-static`. This test lists every `.ts` file of `e2e/` and
// requires each to be imported by `program.ts`, or to be excluded below with its
// reason. It prints what it examined; a folder with nothing to read is a failure.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..", "..");
const E2E = join(APP, "e2e");
const PROGRAM = join(import.meta.dir, "program.ts");

/**
 * Files of `e2e/` that are not in the program, each with its reason. Empty: every
 * e2e file is typechecked. An entry here is a reviewed edit, next to its reason.
 */
const EXCLUDED: Readonly<Record<string, string>> = {};

/** The `.ts` files directly in `e2e/` (its `dist/` holds the bundles, never sources). */
function e2eSources(): string[] {
  return readdirSync(E2E, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

/** The e2e modules `program.ts` imports, as file names. */
function listed(programText: string): Set<string> {
  const names = new Set<string>();
  for (const match of programText.matchAll(/from\s+"\.\.\/\.\.\/e2e\/([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier !== undefined) names.add(`${specifier}.ts`);
  }
  return names;
}

/** What is missing from the program: files neither listed nor excluded. */
function missingFromProgram(
  sources: readonly string[],
  programText: string,
  excluded: Readonly<Record<string, string>>,
): string[] {
  const inProgram = listed(programText);
  return sources.filter((name) => !inProgram.has(name) && excluded[name] === undefined);
}

describe("every e2e file is in the typed program", () => {
  test("each .ts file of e2e/ is imported by program.ts or excluded with a reason", () => {
    const sources = e2eSources();
    const programText = readFileSync(PROGRAM, "utf8");
    const inProgram = listed(programText);
    console.log(
      `program entries: ${sources.length} e2e source(s) examined, ` +
        `${sources.filter((name) => inProgram.has(name)).length} in the program, ` +
        `${Object.keys(EXCLUDED).length} excluded`,
    );
    expect(sources.length).toBeGreaterThan(0);
    expect(missingFromProgram(sources, programText, EXCLUDED)).toEqual([]);
    for (const [name, reason] of Object.entries(EXCLUDED)) {
      expect({ name, reasoned: reason.trim().length > 0 }).toEqual({ name, reasoned: true });
      expect({ name, exists: sources.includes(name) }).toEqual({ name, exists: true });
    }
  });

  test("a file the program does not list is reported, and an exclusion lets it through", () => {
    const programText = 'import type * as Shim from "../../e2e/shim";\n';
    expect(missingFromProgram(["shim.ts", "new.e2e.ts"], programText, {})).toEqual(["new.e2e.ts"]);
    expect(
      missingFromProgram(["shim.ts", "new.e2e.ts"], programText, { "new.e2e.ts": "reason" }),
    ).toEqual([]);
  });
});
