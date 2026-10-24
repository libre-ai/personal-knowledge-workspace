// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-42: the packages of the front are pinned to an exact version, published at
// least three days before they were pinned, under an admitted licence, and
// recorded in `apps/desktop/DEPENDENCIES.md` with the licence read in the
// package and the publication date read on the registry. The checker is a pure
// function over the files it is given, so that each violation has a red vector;
// the test reads the real files and counts what it examined.
//
// The table of the direct dependencies is what CA-42 names. The second table
// records the closure resolved in `bun.lock`: a transitive package under a
// licence outside the list would otherwise pass unseen. The age of the
// transitive packages is enforced at install time by `bunfig.toml`
// (`minimumReleaseAge`, no exclusion), which this checker also pins.
//
// shortcut: `bun.lock` is JSON with trailing commas, read after removing them
// with a regular expression, and only the top-level `packages` keys are
// resolved; a closure that needs a nested key (a second version of a package)
// fails as unresolvable instead of being guessed. Upgrade trigger: the first
// duplicated package in the front's closure.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Licences admitted by CA-42 (I-11, ADR-0042 sections 4 and 11). */
export const ADMITTED_LICENCES: readonly string[] = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "Unicode-3.0",
  "MPL-2.0",
];

export const MINIMUM_AGE_DAYS = 3;
export const MINIMUM_AGE_SECONDS = MINIMUM_AGE_DAYS * 24 * 60 * 60;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

/** One row of `DEPENDENCIES.md`. */
export interface Row {
  readonly name: string;
  readonly version: string;
  readonly licence: string;
  readonly published: string;
  readonly pinned: string;
}

export interface DependencyFiles {
  readonly packageJson: Record<string, unknown>;
  readonly direct: readonly Row[];
  readonly closure: readonly Row[];
  /** The licence of each package as the installed `package.json` states it, by name. */
  readonly installedLicences: ReadonlyMap<string, string>;
  /** The packages `bun.lock` resolves from the dependencies of `apps/desktop`, by name. */
  readonly resolved: ReadonlyMap<string, string>;
  readonly bunfig: string;
}

export interface Violation {
  readonly rule: "pin" | "record" | "licence" | "age" | "installed" | "closure" | "bunfig" | "date";
  readonly detail: string;
}

export interface DependencyReport {
  readonly examined: {
    readonly direct: number;
    readonly closure: number;
    readonly rows: number;
  };
  readonly violations: readonly Violation[];
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const DAY = 24 * 60 * 60 * 1000;

/** `A OR B` is admitted when one alternative is, `A AND B` when both are. Anything else is refused. */
export function licenceAdmitted(expression: string): boolean {
  const ors = expression.split(/\s+OR\s+/);
  return ors.some((alternative) =>
    alternative.split(/\s+AND\s+/).every((licence) => ADMITTED_LICENCES.includes(licence.trim())),
  );
}

function dependencyEntries(packageJson: Record<string, unknown>): Array<[string, string, string]> {
  const entries: Array<[string, string, string]> = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = packageJson[field];
    if (section === undefined) continue;
    if (section === null || typeof section !== "object" || Array.isArray(section)) {
      entries.push([field, "", ""]);
      continue;
    }
    for (const [name, version] of Object.entries(section)) {
      entries.push([field, name, typeof version === "string" ? version : ""]);
    }
  }
  return entries;
}

function checkRow(row: Row, source: string, violations: Violation[]): void {
  if (!licenceAdmitted(row.licence)) {
    violations.push({
      rule: "licence",
      detail: `${source} ${row.name}@${row.version}: licence "${row.licence}" is outside the list`,
    });
  }
  const published = Date.parse(row.published);
  const pinned = Date.parse(row.pinned);
  if (Number.isNaN(published) || Number.isNaN(pinned)) {
    violations.push({
      rule: "date",
      detail: `${source} ${row.name}@${row.version}: "${row.published}" or "${row.pinned}" is not an ISO 8601 date`,
    });
  } else if (pinned - published < MINIMUM_AGE_DAYS * DAY) {
    violations.push({
      rule: "age",
      detail: `${source} ${row.name}@${row.version}: published ${row.published}, pinned ${row.pinned}, under ${MINIMUM_AGE_DAYS} days`,
    });
  }
}

export function checkDependencies(files: DependencyFiles): DependencyReport {
  const violations: Violation[] = [];
  const entries = dependencyEntries(files.packageJson);

  for (const [field, name, version] of entries) {
    if (name === "") {
      violations.push({ rule: "pin", detail: `${field} is not an object` });
      continue;
    }
    if (!EXACT_VERSION.test(version)) {
      violations.push({
        rule: "pin",
        detail: `${name}: "${version}" is not an exact version (no range, tag, protocol or prerelease)`,
      });
    }
    const row = files.direct.find((candidate) => candidate.name === name);
    if (row === undefined) {
      violations.push({ rule: "record", detail: `${name} has no row in DEPENDENCIES.md` });
      continue;
    }
    if (row.version !== version) {
      violations.push({
        rule: "record",
        detail: `${name}: package.json pins ${version}, DEPENDENCIES.md says ${row.version}`,
      });
    }
    const resolved = files.resolved.get(name);
    if (resolved !== version) {
      violations.push({
        rule: "record",
        detail: `${name}: package.json pins ${version}, bun.lock resolves ${resolved ?? "nothing"}`,
      });
    }
    checkRow(row, "direct", violations);
    const installed = files.installedLicences.get(name);
    if (installed === undefined) {
      violations.push({
        rule: "installed",
        detail: `${name} is not installed: the licence cannot be read in the package`,
      });
    } else if (installed !== row.licence) {
      violations.push({
        rule: "installed",
        detail: `${name}: the package says "${installed}", DEPENDENCIES.md says "${row.licence}"`,
      });
    }
  }
  for (const row of files.direct) {
    if (!entries.some(([, name]) => name === row.name)) {
      violations.push({
        rule: "record",
        detail: `${row.name} has a row but no package.json entry`,
      });
    }
  }

  // The closure resolved by bun.lock, and nothing else, is what the second table records.
  for (const [name, version] of files.resolved) {
    const row = files.closure.find((candidate) => candidate.name === name);
    if (row === undefined) {
      violations.push({
        rule: "closure",
        detail: `${name}@${version} has no row in the closure table`,
      });
      continue;
    }
    if (row.version !== version) {
      violations.push({
        rule: "closure",
        detail: `${name}: bun.lock resolves ${version}, the closure table says ${row.version}`,
      });
    }
    checkRow(row, "closure", violations);
    const installed = files.installedLicences.get(name);
    if (installed !== undefined && installed !== row.licence) {
      violations.push({
        rule: "installed",
        detail: `${name}: the package says "${installed}", the closure table says "${row.licence}"`,
      });
    }
  }
  for (const row of files.closure) {
    if (!files.resolved.has(row.name)) {
      violations.push({
        rule: "closure",
        detail: `${row.name} has a row but bun.lock does not resolve it`,
      });
    }
  }

  if (!/^minimumReleaseAge\s*=\s*259200\s*$/m.test(files.bunfig)) {
    violations.push({
      rule: "bunfig",
      detail: `bunfig.toml does not set minimumReleaseAge = ${MINIMUM_AGE_SECONDS}`,
    });
  }
  if (!/^minimumReleaseAgeExcludes\s*=\s*\[\s*\]\s*$/m.test(files.bunfig)) {
    violations.push({
      rule: "bunfig",
      detail: "bunfig.toml excludes a package from minimumReleaseAge",
    });
  }

  return {
    examined: {
      direct: entries.length,
      closure: files.resolved.size,
      rows: files.direct.length + files.closure.length,
    },
    violations,
  };
}

/** The rows of the table that follows `heading` in `DEPENDENCIES.md`. */
export function readRows(markdown: string, heading: string): Row[] {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`DEPENDENCIES.md has no section "${heading}"`);
  const rest = markdown.slice(start + heading.length + 2);
  const end = rest.search(/\n## /);
  const section = end === -1 ? rest : rest.slice(0, end);
  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 7 || !cells[1]?.startsWith("`")) continue;
    const [, name, version, licence, published, pinned] = cells;
    rows.push({
      name: (name ?? "").replaceAll("`", ""),
      version: version ?? "",
      licence: licence ?? "",
      published: published ?? "",
      pinned: pinned ?? "",
    });
  }
  return rows;
}

interface LockFile {
  readonly workspaces: Record<string, { dependencies?: Record<string, string> }>;
  readonly packages: Record<string, [string, string, { dependencies?: Record<string, string> }?]>;
}

/** The packages `bun.lock` resolves from the dependencies of `workspace`, transitive ones included. */
export function resolveClosure(lockText: string, workspace: string): Map<string, string> {
  const lock = JSON.parse(lockText.replace(/,(\s*[}\]])/g, "$1")) as LockFile;
  const roots = lock.workspaces[workspace]?.dependencies;
  if (roots === undefined) throw new Error(`bun.lock has no dependencies for ${workspace}`);
  const resolved = new Map<string, string>();
  const pending = Object.keys(roots);
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || resolved.has(name)) continue;
    const entry = lock.packages[name];
    if (entry === undefined) throw new Error(`bun.lock does not resolve ${name} at the top level`);
    const version = entry[0].slice(entry[0].lastIndexOf("@") + 1);
    resolved.set(name, version);
    pending.push(...Object.keys(entry[2]?.dependencies ?? {}));
  }
  return resolved;
}

/** Reads the real files. A file that cannot be read throws: it is a failure, never an empty pass. */
export function readDependencyFiles(appDirectory: string, repositoryRoot: string): DependencyFiles {
  const packageJson = JSON.parse(
    readFileSync(join(appDirectory, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const markdown = readFileSync(join(appDirectory, "DEPENDENCIES.md"), "utf8");
  const resolved = resolveClosure(
    readFileSync(join(repositoryRoot, "bun.lock"), "utf8"),
    "apps/desktop",
  );
  const installedLicences = new Map<string, string>();
  for (const name of resolved.keys()) {
    // The isolated linker links the direct dependencies under the app and keeps
    // the others in the store of the root; both are read from the package itself.
    for (const base of [
      join(appDirectory, "node_modules", name),
      join(
        repositoryRoot,
        "node_modules",
        ".bun",
        `${name.replace("/", "+")}@${resolved.get(name)}`,
        "node_modules",
        name,
      ),
    ]) {
      try {
        const installed = JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as {
          license?: string;
        };
        if (typeof installed.license === "string") installedLicences.set(name, installed.license);
        break;
      } catch {
        // try the next location; a package found in neither is reported as not installed
      }
    }
  }
  return {
    packageJson,
    direct: readRows(markdown, "## Direct dependencies"),
    closure: readRows(markdown, "## Resolved closure"),
    installedLicences,
    resolved,
    bunfig: readFileSync(join(repositoryRoot, "bunfig.toml"), "utf8"),
  };
}
