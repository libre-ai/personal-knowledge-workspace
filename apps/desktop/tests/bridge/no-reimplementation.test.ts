// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-40: the front reimplements no function of the Rust core. Each red vector
// mutates a copy of the real front (package.json and sources) and must be
// refused by the rule it targets; the real front must pass with something
// examined. The vector the criterion names, an import of `marked`, is the
// first of the "import" group, once as a dependency and once in a source.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALLOWED_DEPENDENCIES,
  checkFront,
  type FrontFiles,
  type Rule,
  readFrontFiles,
  type SourceFile,
  stripComments,
} from "./front-rules";

const APP_DIRECTORY = join(import.meta.dir, "..", "..");
const front = readFrontFiles(APP_DIRECTORY);

type Mutable = { packageJson: Record<string, unknown>; sources: SourceFile[] };

function mutableFront(): Mutable {
  return {
    packageJson: structuredClone(front.packageJson) as Record<string, unknown>,
    sources: structuredClone([...front.sources]),
  };
}

function addDependency(files: Mutable, field: string, name: string): void {
  const section = (files.packageJson[field] ?? {}) as Record<string, string>;
  section[name] = "1.0.0";
  files.packageJson[field] = section;
}

function addSource(files: Mutable, path: string, text: string): void {
  files.sources.push({ path, text });
}

interface Vector {
  readonly name: string;
  readonly rule: Rule;
  readonly mutate: (files: Mutable) => void;
}

const VECTORS: readonly Vector[] = [
  // dependencies of apps/desktop/package.json
  {
    name: "marked is added to dependencies",
    rule: "parser",
    mutate: (f) => addDependency(f, "dependencies", "marked"),
  },
  {
    name: "a Markdown package is added to devDependencies",
    rule: "parser",
    mutate: (f) => addDependency(f, "devDependencies", "markdown-it"),
  },
  {
    name: "a remark plugin is added to peerDependencies",
    rule: "parser",
    mutate: (f) => addDependency(f, "peerDependencies", "remark-gfm"),
  },
  {
    name: "the file system plugin is added to dependencies",
    rule: "filesystem",
    mutate: (f) => addDependency(f, "dependencies", "@tauri-apps/plugin-fs"),
  },
  {
    name: "a search library is added to dependencies",
    rule: "index",
    mutate: (f) => addDependency(f, "dependencies", "minisearch"),
  },
  {
    name: "a package outside the list is added to dependencies",
    rule: "dependency",
    mutate: (f) => addDependency(f, "dependencies", "left-pad"),
  },
  {
    name: "an override adds a package the list never saw",
    rule: "dependency",
    mutate: (f) => {
      f.packageJson.overrides = { "left-pad": "1.0.0" };
    },
  },
  // imports in the sources
  {
    name: "a source imports marked",
    rule: "parser",
    mutate: (f) =>
      addSource(
        f,
        "src/editor/preview.ts",
        'import { marked } from "marked";\nexport const x = 1;\n',
      ),
  },
  {
    name: "a source imports the file system plugin",
    rule: "filesystem",
    mutate: (f) =>
      addSource(
        f,
        "src/editor/files.ts",
        'import { readTextFile } from "@tauri-apps/plugin-fs";\n',
      ),
  },
  {
    name: "a source reads node:fs through require",
    rule: "filesystem",
    mutate: (f) => addSource(f, "src/editor/files.ts", 'const fs = require("node:fs");\n'),
  },
  {
    name: "a source re-exports a Markdown package",
    rule: "parser",
    mutate: (f) => addSource(f, "src/editor/md.ts", 'export * from "micromark";\n'),
  },
  {
    name: "a source imports a Markdown package dynamically",
    rule: "parser",
    mutate: (f) => addSource(f, "src/editor/md.ts", 'const m = await import("remark");\n'),
  },
  {
    name: "a source imports a search library",
    rule: "index",
    mutate: (f) => addSource(f, "src/editor/find.ts", 'import FlexSearch from "flexsearch";\n'),
  },
  {
    name: "a source imports a package outside the list",
    rule: "import",
    mutate: (f) => addSource(f, "src/editor/x.ts", 'import { padStart } from "left-pad";\n'),
  },
  {
    name: "a source imports a computed specifier",
    rule: "import",
    mutate: (f) => addSource(f, "src/editor/x.ts", "const name = pick();\nawait import(name);\n"),
  },
  {
    name: "an import hides behind a URL string on the same line",
    rule: "parser",
    mutate: (f) =>
      addSource(f, "src/editor/x.ts", 'const u = "https://example.test/a"; import("marked");\n'),
  },
  {
    name: "a source outside src/bridge imports the Tauri transport",
    rule: "native",
    mutate: (f) =>
      addSource(f, "src/editor/x.ts", 'import { invoke } from "@tauri-apps/api/core";\n'),
  },
  {
    name: "a source outside src/bridge reaches the Tauri internals",
    rule: "native",
    mutate: (f) =>
      addSource(f, "src/editor/x.ts", "window.__TAURI_INTERNALS__.invoke('read_dir');\n"),
  },
  // the file system, without an import
  {
    name: "a source calls Bun.file",
    rule: "filesystem",
    mutate: (f) => addSource(f, "src/editor/x.ts", 'const f = Bun.file("note.md");\n'),
  },
  {
    name: "a source asks for a directory picker",
    rule: "filesystem",
    mutate: (f) => addSource(f, "src/editor/x.ts", "const d = await showDirectoryPicker();\n"),
  },
  {
    name: "a source opens the origin private file system",
    rule: "filesystem",
    mutate: (f) =>
      addSource(f, "src/editor/x.ts", "const root = await navigator.storage.getDirectory();\n"),
  },
  // hand-written parsers and indexes
  {
    name: "a Markdown parser is declared outside src/bridge",
    rule: "parser",
    mutate: (f) =>
      addSource(
        f,
        "src/editor/preview.ts",
        "export function parseMarkdown(text: string) { return text; }\n",
      ),
  },
  {
    name: "a tokenizer is an arrow function outside src/bridge",
    rule: "parser",
    mutate: (f) =>
      addSource(f, "src/editor/x.ts", "export const tokenize = (s: string) => s.split(' ');\n"),
  },
  {
    name: "a parser class is declared outside src/bridge",
    rule: "parser",
    mutate: (f) => addSource(f, "src/editor/x.ts", "export class MarkdownParser {}\n"),
  },
  {
    name: "an index is built in the front",
    rule: "index",
    mutate: (f) =>
      addSource(
        f,
        "src/editor/x.ts",
        "export function buildIndex(notes: string[]) { return notes; }\n",
      ),
  },
  {
    name: "an index is built in the front, inside src/bridge",
    rule: "index",
    mutate: (f) => addSource(f, "src/bridge/local.ts", "export class NoteIndex {}\n"),
  },
];

function mutated(vector: Vector): FrontFiles {
  const files = mutableFront();
  vector.mutate(files);
  return files;
}

function count(rule: Rule, files: FrontFiles): number {
  return checkFront(files).refusals.filter((refusal) => refusal.rule === rule).length;
}

describe("the shipped front reimplements nothing", () => {
  const report = checkFront(front);

  test("nothing is refused and something is examined", () => {
    console.log(
      `front: ${report.refusals.length} refus ; examined ${report.examined.sources} source(s), ` +
        `${report.examined.imports} import(s), ${report.examined.declarations} declaration(s), ` +
        `${report.examined.dependencies} dependency entry(ies) ; closed list of ${ALLOWED_DEPENDENCIES.length}`,
    );
    expect(report.refusals).toEqual([]);
    expect(report.examined.sources).toBeGreaterThan(0);
    expect(report.examined.imports).toBeGreaterThan(0);
    expect(report.examined.declarations).toBeGreaterThan(0);
  });

  test("the bridge client is among the sources read", () => {
    expect(front.sources.map((source) => source.path)).toContain("src/bridge/client.ts");
  });
});

describe("red vectors: each violation is refused by its rule and counted", () => {
  for (const vector of VECTORS) {
    test(`${vector.rule}: ${vector.name}`, () => {
      const refused = count(vector.rule, mutated(vector));
      console.log(`${vector.rule} vector "${vector.name}": ${refused} refus`);
      expect(refused).toBeGreaterThan(0);
    });
  }

  test("every rule has at least one vector", () => {
    const covered = new Set(VECTORS.map((vector) => vector.rule));
    console.log(`vectors: ${VECTORS.length} for ${covered.size} rules`);
    const rules: Rule[] = ["dependency", "filesystem", "import", "index", "native", "parser"];
    expect([...covered].sort()).toEqual(rules);
  });
});

describe("controls: what the rules must let through", () => {
  test("a parsing function inside src/bridge is allowed (it decodes the bridge's own answers)", () => {
    const files = mutableFront();
    addSource(
      files,
      "src/bridge/decode.ts",
      "export function parseAnswer(raw: unknown) { return raw; }\n",
    );
    expect(count("parser", files)).toBe(0);
  });

  test("the Tauri transport is allowed inside src/bridge", () => {
    const files = mutableFront();
    addSource(files, "src/bridge/transport.ts", 'import { invoke } from "@tauri-apps/api/core";\n');
    expect(checkFront(files).refusals).toEqual([]);
  });

  test("a dependency of the closed list is allowed", () => {
    const files = mutableFront();
    for (const name of ALLOWED_DEPENDENCIES) addDependency(files, "dependencies", name);
    expect(checkFront(files).refusals).toEqual([]);
  });

  test("a commented-out import is not an import", () => {
    expect(
      stripComments('// import x from "marked";\n/* import y from "marked"; */\nconst a = 1;'),
    ).not.toContain("marked");
    const files = mutableFront();
    addSource(
      files,
      "src/editor/x.ts",
      '// import { marked } from "marked";\nexport const a = 1;\n',
    );
    expect(checkFront(files).refusals).toEqual([]);
  });

  test("a variable that merely holds parsed data is not a parser", () => {
    const files = mutableFront();
    addSource(
      files,
      "src/editor/x.ts",
      "export const parsedValue = 3;\nexport const parsedList = [1];\n",
    );
    expect(count("parser", files)).toBe(0);
  });
});

describe("a source that cannot be read is a failure, not an empty pass", () => {
  test("a front without a src folder throws", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-front-"));
    writeFileSync(join(empty, "package.json"), "{}");
    expect(() => readFrontFiles(empty)).toThrow();
  });

  test("a src folder with no source file throws", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-front-"));
    writeFileSync(join(empty, "package.json"), "{}");
    mkdirSync(join(empty, "src"));
    writeFileSync(join(empty, "src", "notes.txt"), "not a source");
    expect(() => readFrontFiles(empty)).toThrow();
  });

  test("a package.json that is not an object is refused", () => {
    expect(count("dependency", { packageJson: [], sources: front.sources })).toBeGreaterThan(0);
  });
});
