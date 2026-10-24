// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// CA-48: check-report.ts exits 0 on a green manifest, 1 on a red one and 2 on an
// incomplete one, and a threshold removed from a green manifest is seen
// non-zero. Each case runs the real command on a throwaway git repository that
// holds a copy of PROTOCOL.md and of the resource-class manifest, so the freeze
// check (PROTOCOL.md section 10.8) runs on a real history.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { evaluate, RAW_SCHEMA, type RawOutput } from "./series/evaluate";
import { MANIFEST_SCHEMA, type ReportManifest, toJsonValue } from "./series/manifest";
import { type MeasureSpec, measureSpecs, readProtocol, seriesParameters } from "./series/protocol";

const repositoryRoot = join(import.meta.dir, "..", "..", "..");
const protocol = readProtocol(repositoryRoot);
const specs = measureSpecs(protocol);
const parameters = seriesParameters(protocol);
const checkReport = join(import.meta.dir, "check-report.ts");
const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
});

// The child sees no variable of the ambient run (a CI run sets GIT_* and more).
function cleanEnvironment(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
}

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, env: cleanEnvironment(root), stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function write(root: string, relative: string, text: string): void {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

// A raw output that passes each threshold, built from the protocol counts.
function greenRaw(spec: MeasureSpec): RawOutput {
  const filled = <T>(length: number, value: T): T[] => Array.from({ length }, () => value);
  switch (spec.kind) {
    case "latency":
      return {
        schema: RAW_SCHEMA,
        kind: "latency",
        unit: "ms",
        samples: filled(spec.count, spec.limit / 2),
      };
    case "memory":
      return {
        schema: RAW_SCHEMA,
        kind: "memory",
        unit: "Mio",
        launches: filled(spec.count, { peakMib: 300, samples: 40 }),
      };
    case "round-trip": {
      const files = spec.limit;
      const pass = { examined: files, identical: files, changed: 0, missing: 0, added: 0 };
      return { schema: RAW_SCHEMA, kind: "round-trip", passes: filled(spec.count, pass) };
    }
    case "paragraph-edit":
      return {
        schema: RAW_SCHEMA,
        kind: "paragraph-edit",
        editableFiles: 9000,
        passes: filled(spec.count, {
          expected: 9000,
          examined: 9000,
          conforming: 9000,
          unexpectedChanges: 0,
        }),
      };
    case "accessibility":
      return {
        schema: RAW_SCHEMA,
        kind: "accessibility",
        role: "AXTextArea",
        total: 1000,
        matching: 1000,
      };
  }
}

interface Fixture {
  raws: Map<string, unknown>;
  manifest: ReportManifest;
}

function greenFixture(commit: string): Fixture {
  const raws = new Map<string, unknown>();
  const measures = specs.map((spec) => {
    const raw = greenRaw(spec);
    const path = `raw/${spec.id}.json`;
    raws.set(path, raw);
    const evaluation = evaluate(spec, raw);
    if (!evaluation.ok) throw new Error(evaluation.issue);
    return {
      id: spec.id,
      measure: spec.measure,
      threshold: spec.threshold,
      raw: path,
      value: toJsonValue(evaluation.value),
      verdict: evaluation.verdict,
    };
  });
  return {
    raws,
    manifest: {
      schema: MANIFEST_SCHEMA,
      trial: false,
      commit,
      createdAt: "2026-10-24T00:00:00Z",
      machine: {
        class: parameters.machineClass,
        operatingSystem: "darwin",
        architecture: "arm64",
        hardwareModel: "fixture",
        processor: "fixture",
        memoryBytes: 34359738368,
        logicalCpu: 12,
        hypervisorPresent: false,
        osVersion: "fixture",
      },
      corpusSha256: parameters.corpusSha256,
      rejectedLaunches: { "session-locked": 0, "display-asleep": 0, "helpers-unattributed": 0 },
      measures,
    },
  };
}

const REPORT = "tools/qualification/p04-tauri/reports/fixture";

interface Options {
  edit?: (fixture: Fixture) => void;
  // Commits PROTOCOL.md once more after the report: the freeze is broken.
  protocolAfterReport?: boolean;
  commitReport?: boolean;
}

function repositoryWith(options: Options = {}): string {
  const root = mkdtempSync(join(tmpdir(), "p04-check-report-"));
  scratch.push(root);
  git(root, "init", "-q");
  write(root, "tools/qualification/p04-tauri/PROTOCOL.md", protocol);
  mkdirSync(join(root, "toolchains"), { recursive: true });
  copyFileSync(
    join(repositoryRoot, "toolchains", "notebook-resource-classes.json"),
    join(root, "toolchains", "notebook-resource-classes.json"),
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "protocol");
  const fixture = greenFixture(git(root, "rev-parse", "HEAD"));
  options.edit?.(fixture);
  for (const [path, raw] of fixture.raws)
    write(root, `${REPORT}/${path}`, `${JSON.stringify(raw)}\n`);
  write(root, `${REPORT}/manifest.json`, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
  if (options.commitReport !== false) {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "report");
  }
  if (options.protocolAfterReport === true) {
    write(root, "tools/qualification/p04-tauri/PROTOCOL.md", `${protocol}\n`);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "protocol after the report");
  }
  return root;
}

function run(root: string, ...extra: string[]): { code: number; out: string } {
  const result = Bun.spawnSync([process.execPath, checkReport, "--root", root, ...extra], {
    env: cleanEnvironment(root),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? -1,
    out: `${result.stdout.toString()}${result.stderr.toString()}`,
  };
}

function measureOf(fixture: Fixture, id: string) {
  const entry = fixture.manifest.measures.find((measure) => measure.id === id);
  if (entry === undefined) throw new Error(`fixture has no ${id}`);
  return entry;
}

describe("check-report.ts exit codes (CA-48)", () => {
  test("a green manifest exits 0 and prints the thresholds examined", () => {
    const { code, out } = run(repositoryWith());
    expect(out).toContain("7 thresholds examined");
    expect(out).toContain("7 pass, 0 fail");
    expect(code).toBe(0);
  });

  test("a red manifest exits 1", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          const spec = specs.find((candidate) => candidate.id === "nfr-03");
          if (spec === undefined) throw new Error("no nfr-03");
          const raw: RawOutput = {
            schema: RAW_SCHEMA,
            kind: "latency",
            unit: "ms",
            samples: Array.from({ length: spec.count }, () => spec.limit + 1),
          };
          fixture.raws.set("raw/nfr-03.json", raw);
          const entry = measureOf(fixture, "nfr-03");
          entry.value = spec.limit + 1;
          entry.verdict = "fail";
        },
      }),
    );
    expect(out).toContain("6 pass, 1 fail");
    expect(code).toBe(1);
  });

  test("an incomplete manifest (raw output missing) exits 2", () => {
    const root = repositoryWith({ commitReport: false });
    unlinkSync(join(root, REPORT, "raw", "nfr-10.json"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "report");
    const { code, out } = run(root);
    expect(out).toContain("incomplete");
    expect(code).toBe(2);
  });

  test("red vector: a threshold removed from a green manifest is non-zero", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.manifest.measures = fixture.manifest.measures.filter(
            (measure) => measure.id !== "accessibility",
          );
        },
      }),
    );
    expect(out).toContain("6 thresholds examined");
    expect(code).not.toBe(0);
    expect(code).toBe(2);
  });
});

describe("check-report.ts recomputes instead of trusting the manifest", () => {
  test("a declared pass that the raw output contradicts is incomplete", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.raws.set("raw/nfr-10.json", {
            schema: RAW_SCHEMA,
            kind: "memory",
            unit: "Mio",
            launches: Array.from({ length: parameters.nfr10Launches }, () => ({
              peakMib: 501,
              samples: 3,
            })),
          });
        },
      }),
    );
    expect(out).toContain("nfr-10");
    expect(code).toBe(2);
  });

  test("a raw output with fewer samples than the protocol count is incomplete", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.raws.set("raw/at-02-1-mib.json", {
            schema: RAW_SCHEMA,
            kind: "latency",
            unit: "ms",
            samples: [1, 2, 3],
          });
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("an unavailable measure is incomplete, never green", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.raws.set("raw/accessibility.json", {
            schema: RAW_SCHEMA,
            kind: "unavailable",
            reason: "fixture",
          });
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("a threshold rewritten in the manifest is incomplete", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          measureOf(fixture, "at-02-5000-lines").threshold = "p95 ≤ 32 ms";
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("a raw path that leaves the report directory is refused", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          measureOf(fixture, "nfr-03").raw = "../../PROTOCOL.md";
        },
      }),
    );
    expect(code).toBe(2);
  });
});

describe("check-report.ts binds the report to the protocol, the corpus and the machine", () => {
  test("another corpus SHA-256 is incomplete", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.manifest.corpusSha256 = "0".repeat(64);
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("a machine outside the protocol class is incomplete", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.manifest.machine.memoryBytes = 17179869184;
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("a trial run is never a report", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.manifest.trial = true;
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("a commit unknown to the repository is incomplete", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.manifest.commit = "f".repeat(40);
        },
      }),
    );
    expect(code).toBe(2);
  });
});

describe("freeze check (PROTOCOL.md section 10.8)", () => {
  test("PROTOCOL.md changed after the report breaks the freeze", () => {
    const { code, out } = run(repositoryWith({ protocolAfterReport: true }));
    expect(out).toContain("freeze");
    expect(code).toBe(2);
  });

  test("a report that is not committed cannot be checked", () => {
    const { code, out } = run(repositoryWith({ commitReport: false }));
    expect(out).toContain("freeze");
    expect(code).toBe(2);
  });

  test("a shallow history cannot be checked", () => {
    const root = repositoryWith();
    const clone = mkdtempSync(join(tmpdir(), "p04-check-report-shallow-"));
    scratch.push(clone);
    git(clone, "clone", "-q", "--depth", "1", `file://${root}`, "repository");
    const { code, out } = run(join(clone, "repository"));
    expect(out).toContain("shallow");
    expect(code).toBe(2);
  });

  test("no report at all is incomplete, not green", () => {
    const root = mkdtempSync(join(tmpdir(), "p04-check-report-empty-"));
    scratch.push(root);
    git(root, "init", "-q");
    write(root, "tools/qualification/p04-tauri/PROTOCOL.md", protocol);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "protocol");
    const { code, out } = run(root);
    expect(out).toContain("0 thresholds examined");
    expect(code).toBe(2);
  });
});
