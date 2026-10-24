// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-40: the front reimplements no function of the Rust core. The checker reads
// `apps/desktop/package.json` and the sources of `apps/desktop/src/` and refuses
// a dependency outside a closed list, an import that would give the front a
// Markdown parser, a file system or an index, and a function of the same kind
// written by hand outside `src/bridge/`, and dynamic code, network or web storage
// named in any source. Every rule reports what it examined: a
// front with no source to read is a failure, never a green.
//
// shortcut: the source is read lexically (comments stripped, strings kept), not
// through a TypeScript AST; an obfuscated parser (a function renamed to
// something innocent, a method named `parse`, an import assembled at run time)
// is not seen. Dynamic code, network and web storage are refused by name
// (`eval`, `Function(`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
// `localStorage`, `sessionStorage`, `indexedDB`); a name assembled at run time
// (`globalThis["fe" + "tch"]`), an alias of `Function` (`const F = Function`)
// or a constructor reached through a prototype (`(() => {}).constructor(...)`)
// is not seen, and what stops those at run time is the window, not this
// checker: `script-src 'self'` without `unsafe-eval` and `connect-src` limited
// to the IPC origins in `src-tauri/tauri.conf.json`. `incognito: true` keeps
// web storage from outliving the session; it does not forbid it within one.
// Upgrade trigger: the editor package (WP-4) adds source the lexical rules
// cannot judge; then read the AST with the compiler API.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Rule =
  | "dependency"
  | "import"
  | "filesystem"
  | "native"
  | "parser"
  | "index"
  | "runtime";

export interface Refusal {
  readonly rule: Rule;
  readonly file: string;
  readonly detail: string;
}

export interface SourceFile {
  /** Path relative to `apps/desktop`, `/`-separated: `src/bridge/client.ts`. */
  readonly path: string;
  readonly text: string;
}

export interface FrontFiles {
  readonly packageJson: unknown;
  readonly sources: readonly SourceFile[];
}

export interface FrontReport {
  readonly examined: {
    readonly dependencies: number;
    readonly sources: number;
    readonly imports: number;
    readonly declarations: number;
  };
  readonly refusals: readonly Refusal[];
}

/**
 * The only packages the front may depend on, directly or by import. Closed on
 * purpose: adding one is a reviewed edit of this list, next to its reason.
 * - `@tauri-apps/api`: the transport of the bridge, imported from `src/bridge/` only.
 * - `@codemirror/*` (state, view, commands): the editor of EF-P04-10, which edits text
 *   and parses none of it; `lang-markdown` and `@lezer/markdown` stay out (the preview
 *   comes from `render_preview`).
 *
 * WP-4 (CA-41, CA-42) uses exactly these four and keeps the list closed on them:
 * `@codemirror/autocomplete` (closing brackets, completions) and `@codemirror/language`
 * (indent on input) insert text the user did not type, and `@codemirror/search` adds no
 * need of the editor. `tests/editor/dependencies.test.ts` pins the four names and refuses
 * each of those as a dependency and as an import. The transitive packages that come with
 * `@codemirror/commands` are recorded in `DEPENDENCIES.md`; nothing in `src/` imports them.
 */
export const ALLOWED_DEPENDENCIES: readonly string[] = [
  "@tauri-apps/api",
  "@codemirror/commands",
  "@codemirror/state",
  "@codemirror/view",
];

/** Why a name is refused, for the message; a name outside the list is refused anyway. */
const FORBIDDEN_PACKAGES: ReadonlyArray<{ readonly pattern: RegExp; readonly rule: Rule }> = [
  { pattern: /^@tauri-apps\/plugin-fs$/, rule: "filesystem" },
  { pattern: /^(?:node:)?fs(?:\/.*)?$/, rule: "filesystem" },
  { pattern: /^(?:node:)?(?:path|os|child_process)$/, rule: "filesystem" },
  {
    pattern:
      /^(?:marked|markdown-it|markdown-to-jsx|showdown|commonmark|snarkdown|remarkable|micromark(?:-.*)?|remark(?:-.*)?|rehype(?:-.*)?|unified|mdast(?:-.*)?|@lezer\/markdown|@codemirror\/lang-markdown|@mdx-js\/.*|react-markdown|turndown|gray-matter)$/,
    rule: "parser",
  },
  {
    pattern:
      /^(?:flexsearch|minisearch|lunr|elasticlunr|fuse\.js|@orama\/.*|orama|search-index|itemsjs|ufuzzy|@leeoniya\/ufuzzy)$/,
    rule: "index",
  },
];

/** Names that mean "parse text" or "build an index" when a function or class carries them. */
const PARSER_NAME = /^(?:[Pp]arse|[Tt]okeni[sz]e|[Ll]ex(?:er)?$|[Mm]arkdown|md[A-Z]|toHtml)/;
const INDEX_NAME =
  /^(?:[Bb]uildIndex|[Cc]reateIndex|[Ii]nvertedIndex|[Ff]ullText|[Ss]earchIndex|[Ii]ndexNotes?|NoteIndex)/;

const FILESYSTEM_USE: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\bBun\s*\.\s*(?:file|write|stdin)\b/, what: "Bun file API" },
  {
    pattern: /\b(?:showOpenFilePicker|showSaveFilePicker|showDirectoryPicker)\b/,
    what: "File System Access picker",
  },
  { pattern: /\bFileSystem(?:File|Directory)Handle\b/, what: "File System Access handle" },
  { pattern: /\bstorage\s*\.\s*getDirectory\s*\(/, what: "origin private file system" },
  { pattern: /\bprocess\s*\.\s*binding\b/, what: "process.binding" },
];

/**
 * Dynamic code, network and web storage by name. The window already stops them
 * at run time (`script-src 'self'` without `unsafe-eval`, `connect-src` limited
 * to the IPC origins, `incognito: true`; `tauri.conf.json`), so a source that
 * names one is dead code at best and a way to wrong the user's data at worst:
 * the front holds no state and reaches nothing but the bridge. `eval` and the
 * storage and network names are refused wherever they appear (an alias is as
 * bad as a call); `Function` only called, since it is also a TypeScript type.
 */
const RUNTIME_USE: ReadonlyArray<{ readonly pattern: RegExp; readonly what: string }> = [
  { pattern: /\beval\b/, what: "eval" },
  { pattern: /\b(?:new\s+)?Function\s*\(/, what: "Function constructor" },
  { pattern: /\bfetch\b/, what: "fetch" },
  { pattern: /\b(?:XMLHttpRequest|WebSocket|EventSource)\b/, what: "network API" },
  { pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/, what: "web storage" },
];

/** Only `src/bridge/` may reach the native side; the rest of the front goes through it. */
const NATIVE_USE = /__TAURI_INTERNALS__|__TAURI__/;

function packageNameOf(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function isAllowed(name: string): boolean {
  return ALLOWED_DEPENDENCIES.includes(name);
}

/**
 * Blanks out comments and keeps strings, so that a `//` inside a URL string does
 * not hide the rest of its line (an import after it must still be seen) and a
 * commented-out import is not read as one. A template literal is read up to its
 * next backtick: `${}` nesting is not tracked (see the shortcut above).
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === "/" && next === "/") {
      while (index < source.length && source.charAt(index) !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, " ");
      index = stop;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source.charAt(end) !== char) {
        end += source.charAt(end) === "\\" ? 2 : 1;
      }
      out += source.slice(index, end + 1);
      index = end + 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

interface ImportSighting {
  readonly specifier: string | null;
  readonly dynamic: boolean;
}

const STATIC_IMPORT = /\bimport\s*(?:type\s+)?(?:[^'"();]*?\bfrom\s*)?["']([^"']+)["']/g;
const EXPORT_FROM = /\bexport\s+(?:type\s+)?[^'";]*?\bfrom\s*["']([^"']+)["']/g;
const LITERAL_CALL = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
const COMPUTED_CALL = /\b(?:import|require)\s*\(\s*(?!["'])[^)]/g;

function importsOf(code: string): ImportSighting[] {
  const found: ImportSighting[] = [];
  for (const pattern of [STATIC_IMPORT, EXPORT_FROM, LITERAL_CALL]) {
    for (const match of code.matchAll(pattern)) {
      found.push({ specifier: match[1] ?? null, dynamic: false });
    }
  }
  for (const _ of code.matchAll(COMPUTED_CALL)) found.push({ specifier: null, dynamic: true });
  return found;
}

const FUNCTION_DECLARATION = /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/g;
const CLASS_DECLARATION = /\bclass\s+([A-Za-z_$][\w$]*)/g;
/** A variable that holds a function: `const f = (…) =>`, `const f = x =>`, `const f = function`. */
const FUNCTION_VALUE =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g;

/** Functions and classes the source declares, by name. Methods are not read (see the shortcut above). */
function declarationsOf(code: string): string[] {
  return [FUNCTION_DECLARATION, CLASS_DECLARATION, FUNCTION_VALUE].flatMap((pattern) =>
    [...code.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkPackage(packageJson: unknown): { refusals: Refusal[]; examined: number } {
  const refusals: Refusal[] = [];
  let examined = 0;
  const file = "package.json";
  if (!isRecord(packageJson)) {
    return { refusals: [{ rule: "dependency", file, detail: "not an object" }], examined };
  }
  for (const field of DEPENDENCY_FIELDS) {
    const section = packageJson[field];
    if (section === undefined) continue;
    if (!isRecord(section)) {
      refusals.push({ rule: "dependency", file, detail: `${field} is not an object` });
      continue;
    }
    for (const name of Object.keys(section)) {
      examined += 1;
      if (isAllowed(name)) continue;
      const forbidden = FORBIDDEN_PACKAGES.find(({ pattern }) => pattern.test(name));
      refusals.push({
        rule: forbidden?.rule ?? "dependency",
        file,
        detail: `${field}: ${name} is outside the closed list`,
      });
    }
  }
  // `overrides`, `resolutions` and `bundledDependencies` would add packages the list never saw.
  for (const field of ["overrides", "resolutions", "bundledDependencies", "bundleDependencies"]) {
    if (packageJson[field] !== undefined) {
      refusals.push({ rule: "dependency", file, detail: `${field} is declared` });
    }
  }
  return { refusals, examined };
}

export function checkFront(files: FrontFiles): FrontReport {
  const pkg = checkPackage(files.packageJson);
  const refusals: Refusal[] = [...pkg.refusals];
  let imports = 0;
  let declarations = 0;

  for (const { path, text } of files.sources) {
    const code = stripComments(text);
    const inBridge = path.startsWith("src/bridge/");

    for (const sighting of importsOf(code)) {
      imports += 1;
      if (sighting.specifier === null) {
        refusals.push({ rule: "import", file: path, detail: "import() with a computed specifier" });
        continue;
      }
      const { specifier } = sighting;
      const forbidden = FORBIDDEN_PACKAGES.find(({ pattern }) => pattern.test(specifier));
      if (forbidden !== undefined) {
        refusals.push({ rule: forbidden.rule, file: path, detail: `imports ${specifier}` });
      } else if (isBare(specifier) && !isAllowed(packageNameOf(specifier))) {
        refusals.push({
          rule: "import",
          file: path,
          detail: `imports ${specifier}, not in the list`,
        });
      } else if (packageNameOf(specifier) === "@tauri-apps/api" && !inBridge) {
        refusals.push({
          rule: "native",
          file: path,
          detail: `imports ${specifier} outside src/bridge/`,
        });
      }
    }

    for (const { pattern, what } of FILESYSTEM_USE) {
      if (pattern.test(code)) refusals.push({ rule: "filesystem", file: path, detail: what });
    }
    for (const { pattern, what } of RUNTIME_USE) {
      if (pattern.test(code)) refusals.push({ rule: "runtime", file: path, detail: what });
    }
    if (!inBridge && NATIVE_USE.test(code)) {
      refusals.push({ rule: "native", file: path, detail: "native internals outside src/bridge/" });
    }

    for (const name of declarationsOf(code)) {
      declarations += 1;
      if (!inBridge && PARSER_NAME.test(name)) {
        refusals.push({ rule: "parser", file: path, detail: `declares ${name}` });
      }
      if (INDEX_NAME.test(name)) {
        refusals.push({ rule: "index", file: path, detail: `declares ${name}` });
      }
    }
  }

  return {
    examined: {
      dependencies: pkg.examined,
      sources: files.sources.length,
      imports,
      declarations,
    },
    refusals,
  };
}

function walk(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, found);
    else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) found.push(path);
  }
  return found;
}

/** Reads the front. A folder that cannot be read, or that holds no source, throws: it is a failure, never an empty pass. */
export function readFrontFiles(appDirectory: string): FrontFiles {
  const packageJson: unknown = JSON.parse(readFileSync(join(appDirectory, "package.json"), "utf8"));
  const sourceDirectory = join(appDirectory, "src");
  const sources = walk(sourceDirectory).map((file) => ({
    path: relative(appDirectory, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));
  if (sources.length === 0) throw new Error(`no source file under ${sourceDirectory}`);
  return { packageJson, sources };
}
