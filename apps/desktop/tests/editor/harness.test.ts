// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// The e2e harness opens a loopback port, which the shell must never do (control
// C6). It exists as a separate binary behind a cargo feature that no default
// enables, and nothing the shell ships reaches it. These tests pin that isolation
// on the files; the dynamic proof that the shell opens no port is
// `tests/shell/e2e.ts` (`lsof`), unchanged.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(import.meta.dir, "..", "..");
const SHELL = join(APP, "src-tauri");

function walk(directory: string, extension: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, extension, found);
    else if (entry.name.endsWith(extension)) found.push(path);
  }
  return found;
}

export interface Isolation {
  readonly cargoToml: string;
  readonly rustSources: ReadonlyMap<string, string>;
  readonly frontSources: ReadonlyMap<string, string>;
}

/** The ways the harness could leak into what ships. Empty when it cannot. */
export function leaks({ cargoToml, rustSources, frontSources }: Isolation): string[] {
  const found: string[] = [];
  const defaults = /^default\s*=\s*\[([^\]]*)\]/m.exec(cargoToml)?.[1];
  if (defaults === undefined) found.push("Cargo.toml has no default feature list");
  else if (defaults.includes("e2e-harness")) found.push("e2e-harness is a default feature");
  else if (defaults.includes("tauri/test")) found.push("tauri/test is a default feature");

  // A table of Cargo.toml ends at the next blank line in this file.
  const bin = cargoToml
    .split(/\n\s*\n/)
    .find((table) => /^\[\[bin\]\]/m.test(table) && /name\s*=\s*"e2e-harness"/.test(table));
  if (bin === undefined) found.push("the e2e-harness binary is not declared");
  else if (!/required-features\s*=\s*\["e2e-harness"\]/.test(bin)) {
    found.push("the e2e-harness binary does not require its feature");
  }
  if (!/^e2e-harness\s*=\s*\["tauri\/test"\]/m.test(cargoToml)) {
    found.push("the e2e-harness feature is not the mock runtime only");
  }

  for (const [path, text] of rustSources) {
    if (path === "bin/e2e_harness.rs") continue;
    if (/TcpListener|UdpSocket|\.bind\(/.test(text)) found.push(`${path} opens a socket`);
    if (/e2e_harness|e2e-harness/.test(text)) found.push(`${path} names the harness`);
  }
  for (const [path, text] of frontSources) {
    // An import of the e2e folder, or one of the globals the shim defines. A comment
    // may name the run (the seam of `note-editor.ts` is documented by what uses it).
    if (/(?:from|import)\s*["'][^"']*e2e[^"']*["']|__ipcLog|__cspViolations/.test(text)) {
      found.push(`${path} reaches test support`);
    }
  }
  return found;
}

function read(): Isolation {
  const rustSources = new Map(
    walk(join(SHELL, "src"), ".rs").map((file) => [
      relative(join(SHELL, "src"), file).split("\\").join("/"),
      readFileSync(file, "utf8"),
    ]),
  );
  const frontSources = new Map(
    [...walk(join(APP, "src"), ".ts"), ...walk(join(APP, "src"), ".html")].map((file) => [
      relative(APP, file).split("\\").join("/"),
      readFileSync(file, "utf8"),
    ]),
  );
  return { cargoToml: readFileSync(join(SHELL, "Cargo.toml"), "utf8"), rustSources, frontSources };
}

describe("the e2e harness stays out of what ships", () => {
  const real = read();

  test("nothing leaks, and something was examined", () => {
    console.log(
      `harness isolation: ${real.rustSources.size} Rust source(s), ${real.frontSources.size} front source(s), ${leaks(real).length} leak(s)`,
    );
    expect(real.rustSources.has("bin/e2e_harness.rs")).toBe(true);
    expect(real.rustSources.size).toBeGreaterThan(3);
    expect(real.frontSources.size).toBeGreaterThan(5);
    for (const leak of leaks(real)) console.log(`leak: ${leak}`);
    expect(leaks(real)).toEqual([]);
  });

  const vectors: ReadonlyArray<[string, (isolation: Isolation) => Isolation]> = [
    [
      "the harness feature becomes a default",
      (i) => ({
        ...i,
        cargoToml: i.cargoToml.replace(
          'default = ["custom-protocol"]',
          'default = ["custom-protocol", "e2e-harness"]',
        ),
      }),
    ],
    [
      "the mock runtime becomes a default feature",
      (i) => ({
        ...i,
        cargoToml: i.cargoToml.replace(
          'default = ["custom-protocol"]',
          'default = ["custom-protocol", "tauri/test"]',
        ),
      }),
    ],
    [
      "the harness binary no longer requires its feature",
      (i) => ({
        ...i,
        cargoToml: i.cargoToml.replace('required-features = ["e2e-harness"]\n', ""),
      }),
    ],
    [
      "the feature pulls more than the mock runtime",
      (i) => ({
        ...i,
        cargoToml: i.cargoToml.replace(
          'e2e-harness = ["tauri/test"]',
          'e2e-harness = ["tauri/test", "custom-protocol"]',
        ),
      }),
    ],
    [
      "the bridge opens a listener",
      (i) => ({
        ...i,
        rustSources: new Map([...i.rustSources, ["bridge.rs", "let l = TcpListener::bind(a);"]]),
      }),
    ],
    [
      "the shell names the harness",
      (i) => ({
        ...i,
        rustSources: new Map([...i.rustSources, ["lib.rs", "// e2e-harness"]]),
      }),
    ],
    [
      "the front imports test support",
      (i) => ({
        ...i,
        frontSources: new Map([...i.frontSources, ["src/main.ts", 'import "../e2e/shim";']]),
      }),
    ],
  ];

  for (const [name, mutate] of vectors) {
    test(`red vector: ${name}`, () => {
      const found = leaks(mutate(real));
      console.log(`harness vector "${name}": ${found.length} leak(s)`);
      expect(found.length).toBeGreaterThan(0);
    });
  }
});
