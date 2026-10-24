// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-42: every package of the front is pinned exactly, old enough, under an
// admitted licence, and recorded in DEPENDENCIES.md. The red vectors mutate a
// copy of the real files and each must be refused by its rule; the closed list
// of packages the front may use is the one of `tests/bridge/front-rules.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ALLOWED_DEPENDENCIES, checkFront, readFrontFiles } from "../bridge/front-rules";
import {
  ADMITTED_LICENCES,
  checkDependencies,
  type DependencyFiles,
  licenceAdmitted,
  type Row,
  readDependencyFiles,
  resolveClosure,
  type Violation,
} from "./dependencies";

const APP = join(import.meta.dir, "..", "..");
const ROOT = join(APP, "..", "..");
const real = readDependencyFiles(APP, ROOT);

type EditableRow = { -readonly [K in keyof Row]: Row[K] };

type Mutable = {
  packageJson: Record<string, unknown>;
  direct: EditableRow[];
  closure: EditableRow[];
  installedLicences: Map<string, string>;
  resolved: Map<string, string>;
  bunfig: string;
};

function copy(): Mutable {
  return {
    packageJson: structuredClone(real.packageJson),
    direct: real.direct.map((row) => ({ ...row })),
    closure: real.closure.map((row) => ({ ...row })),
    installedLicences: new Map(real.installedLicences),
    resolved: new Map(real.resolved),
    bunfig: real.bunfig,
  };
}

function count(files: DependencyFiles, rule: Violation["rule"]): number {
  return checkDependencies(files).violations.filter((violation) => violation.rule === rule).length;
}

function dependencies(files: Mutable): Record<string, string> {
  return files.packageJson.dependencies as Record<string, string>;
}

function row(rows: EditableRow[], name: string): EditableRow {
  const found = rows.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

describe("the shipped dependencies hold CA-42", () => {
  const report = checkDependencies(real);

  test("nothing is refused and something is examined", () => {
    console.log(
      `dependencies: ${report.examined.direct} direct entry(ies), ${report.examined.closure} package(s) in the closure, ${report.examined.rows} row(s) read, ${report.violations.length} violation(s)`,
    );
    expect(report.violations).toEqual([]);
    expect(report.examined.direct).toBeGreaterThan(0);
    expect(report.examined.closure).toBeGreaterThan(report.examined.direct);
  });

  test("the direct dependencies are exactly the closed list the front may use", () => {
    const names = Object.keys(dependencies({ ...copy() })).sort();
    expect(names).toEqual([...ALLOWED_DEPENDENCIES].sort());
  });

  test("every direct row is also a row of the closure", () => {
    for (const direct of real.direct) {
      expect(row([...real.closure], direct.name)).toEqual(direct);
    }
  });

  test("bunfig.toml enforces the age at install time, with no exclusion", () => {
    expect(real.bunfig).toMatch(/^minimumReleaseAge = 259200$/m);
    expect(real.bunfig).toMatch(/^minimumReleaseAgeExcludes = \[\]$/m);
  });

  test("the front rules of CA-40 accept the dependencies as they are", () => {
    const front = readFrontFiles(APP);
    expect(checkFront(front).refusals).toEqual([]);
  });
});

describe("red vectors: each violation is refused by its rule and counted", () => {
  const vectors: ReadonlyArray<{
    name: string;
    rule: Violation["rule"];
    mutate: (files: Mutable) => void;
  }> = [
    {
      name: "a caret range",
      rule: "pin",
      mutate: (f) => {
        dependencies(f)["@codemirror/state"] = "^6.7.6";
      },
    },
    {
      name: "a tilde range",
      rule: "pin",
      mutate: (f) => {
        dependencies(f)["@codemirror/view"] = "~6.43.15";
      },
    },
    {
      name: "the latest tag",
      rule: "pin",
      mutate: (f) => {
        dependencies(f)["@codemirror/commands"] = "latest";
      },
    },
    {
      name: "a star",
      rule: "pin",
      mutate: (f) => {
        dependencies(f)["@tauri-apps/api"] = "*";
      },
    },
    {
      name: "a git dependency",
      rule: "pin",
      mutate: (f) => {
        dependencies(f)["@codemirror/state"] = "github:codemirror/state#main";
      },
    },
    {
      name: "a prerelease",
      rule: "pin",
      mutate: (f) => {
        dependencies(f)["@codemirror/state"] = "6.7.6-beta.1";
      },
    },
    {
      name: "a dependency with no row",
      rule: "record",
      mutate: (f) => {
        f.direct = f.direct.filter((candidate) => candidate.name !== "@codemirror/view");
      },
    },
    {
      name: "a row that disagrees with package.json",
      rule: "record",
      mutate: (f) => {
        row(f.direct, "@codemirror/state").version = "6.7.5";
      },
    },
    {
      name: "a row for a package that is not a dependency",
      rule: "record",
      mutate: (f) => {
        f.direct.push({ ...row(f.direct, "@codemirror/state"), name: "left-pad" });
      },
    },
    {
      name: "a version that bun.lock does not resolve",
      rule: "record",
      mutate: (f) => {
        f.resolved.set("@codemirror/state", "6.7.5");
      },
    },
    {
      name: "a licence outside the list",
      rule: "licence",
      mutate: (f) => {
        row(f.direct, "@codemirror/view").licence = "GPL-3.0-only";
        row(f.closure, "@codemirror/view").licence = "GPL-3.0-only";
      },
    },
    {
      name: "a licence expression with an AND outside the list",
      rule: "licence",
      mutate: (f) => {
        row(f.closure, "crelt").licence = "MIT AND GPL-3.0-only";
      },
    },
    {
      name: "a licence the package does not state",
      rule: "installed",
      mutate: (f) => {
        row(f.direct, "@codemirror/commands").licence = "ISC";
        row(f.closure, "@codemirror/commands").licence = "ISC";
      },
    },
    {
      name: "a package that is not installed",
      rule: "installed",
      mutate: (f) => {
        f.installedLicences.delete("@codemirror/state");
      },
    },
    {
      name: "a package published two days before it was pinned",
      rule: "age",
      mutate: (f) => {
        row(f.direct, "@codemirror/view").published = "2026-10-22T12:00:00.000Z";
      },
    },
    {
      name: "a transitive package published two days before it was pinned",
      rule: "age",
      mutate: (f) => {
        row(f.closure, "style-mod").published = "2026-10-22T12:00:00.000Z";
      },
    },
    {
      name: "a publication date that is not a date",
      rule: "date",
      mutate: (f) => {
        row(f.direct, "@codemirror/state").published = "last month";
      },
    },
    {
      name: "a resolved package with no row in the closure",
      rule: "closure",
      mutate: (f) => {
        f.closure = f.closure.filter((candidate) => candidate.name !== "w3c-keyname");
      },
    },
    {
      name: "a row of the closure that bun.lock no longer resolves",
      rule: "closure",
      mutate: (f) => {
        f.closure.push({ ...row(f.closure, "crelt"), name: "left-pad" });
      },
    },
    {
      name: "a closure row whose version is not the resolved one",
      rule: "closure",
      mutate: (f) => {
        row(f.closure, "@lezer/common").version = "1.5.2";
      },
    },
    {
      name: "the install-time age is lowered",
      rule: "bunfig",
      mutate: (f) => {
        f.bunfig = f.bunfig.replace("minimumReleaseAge = 259200", "minimumReleaseAge = 0");
      },
    },
    {
      name: "a package is excluded from the install-time age",
      rule: "bunfig",
      mutate: (f) => {
        f.bunfig = f.bunfig.replace(
          "minimumReleaseAgeExcludes = []",
          'minimumReleaseAgeExcludes = ["@codemirror/view"]',
        );
      },
    },
  ];

  for (const vector of vectors) {
    test(`${vector.rule}: ${vector.name}`, () => {
      const files = copy();
      vector.mutate(files);
      const refused = count(files, vector.rule);
      console.log(`${vector.rule} vector "${vector.name}": ${refused} refus`);
      expect(refused).toBeGreaterThan(0);
    });
  }

  test("every rule has at least one vector", () => {
    const covered = new Set(vectors.map((vector) => vector.rule));
    console.log(`vectors: ${vectors.length} for ${covered.size} rules`);
    const rules: Array<Violation["rule"]> = [
      "age",
      "bunfig",
      "closure",
      "date",
      "installed",
      "licence",
      "pin",
      "record",
    ];
    expect([...covered].sort()).toEqual(rules);
  });
});

describe("the closed list of the front stays closed", () => {
  test("it holds exactly the four packages the editor and the bridge use", () => {
    expect([...ALLOWED_DEPENDENCIES].sort()).toEqual([
      "@codemirror/commands",
      "@codemirror/state",
      "@codemirror/view",
      "@tauri-apps/api",
    ]);
  });

  test("a package outside the list is refused as a dependency and as an import", () => {
    const front = readFrontFiles(APP);
    for (const name of [
      "@codemirror/autocomplete",
      "@codemirror/language",
      "@codemirror/search",
      "@codemirror/lang-markdown",
      "@lezer/markdown",
      "left-pad",
    ]) {
      const asDependency = checkFront({
        packageJson: { dependencies: { [name]: "1.0.0" } },
        sources: front.sources,
      });
      expect(asDependency.refusals.length, `dependency ${name}`).toBeGreaterThan(0);
      const asImport = checkFront({
        packageJson: front.packageJson,
        sources: [
          ...front.sources,
          { path: "src/editor/extra.ts", text: `import { x } from "${name}";\n` },
        ],
      });
      expect(asImport.refusals.length, `import ${name}`).toBeGreaterThan(0);
    }
  });
});

describe("the helpers", () => {
  test("licenceAdmitted reads OR and AND", () => {
    expect(licenceAdmitted("MIT")).toBe(true);
    expect(licenceAdmitted("Apache-2.0 OR MIT")).toBe(true);
    expect(licenceAdmitted("GPL-3.0-only OR MIT")).toBe(true);
    expect(licenceAdmitted("MIT AND GPL-3.0-only")).toBe(false);
    expect(licenceAdmitted("GPL-3.0-only")).toBe(false);
    expect(licenceAdmitted("")).toBe(false);
    expect(ADMITTED_LICENCES).toContain("MPL-2.0");
  });

  test("resolveClosure follows the dependencies and fails on a package it cannot find", () => {
    const lock = `{
      "workspaces": { "apps/desktop": { "dependencies": { "a": "1.0.0" } } },
      "packages": {
        "a": ["a@1.0.0", "", { "dependencies": { "b": "^1.0.0" } }, "sha"],
        "b": ["b@1.2.0", "", {}, "sha"],
      }
    }`;
    expect([...resolveClosure(lock, "apps/desktop")]).toEqual([
      ["a", "1.0.0"],
      ["b", "1.2.0"],
    ]);
    expect(() =>
      resolveClosure(lock.replace('"b": ["b@1.2.0", "", {}, "sha"],', ""), "apps/desktop"),
    ).toThrow();
    expect(() => resolveClosure(lock, "apps/missing")).toThrow();
  });

  test("the lock file is read from the repository root", () => {
    expect(readFileSync(join(ROOT, "bun.lock"), "utf8")).toContain('"apps/desktop"');
  });
});
