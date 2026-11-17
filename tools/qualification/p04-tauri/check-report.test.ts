// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// CA-48: check-report.ts exits 0 on a green manifest, 1 on a red one and 2 on an
// incomplete one, and a threshold removed from a green manifest is seen
// non-zero. Each case runs the real command on a throwaway git repository that
// holds a copy of PROTOCOL.md and of the resource-class manifest, so the freeze
// check (PROTOCOL.md section 10.8) runs on a real history.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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

// The binary and instrument of the fixture run, carried by the manifest and by every raw output.
const WITH = {
  binarySha256: createHash("sha256").update("fixture binary").digest("hex"),
  harnessCommit: "b".repeat(40),
  scriptSha256: "c".repeat(64),
};

// A raw output that passes each threshold, built from the protocol counts.
function greenRaw(spec: MeasureSpec): RawOutput {
  const identity =
    spec.note === null
      ? { measure: spec.id, interruptions: [], measuredWith: WITH }
      : { measure: spec.id, note: spec.note, interruptions: [], measuredWith: WITH };
  return { ...identity, ...greenBody(spec) } as unknown as RawOutput;
}

const filled = <T>(length: number, value: T): T[] => Array.from({ length }, () => value);
// AT-02: a gap of 2 ms from observation to bound per keystroke; NFR-03: 3 callbacks per launch.
const GAP_MS = 2;
const latencyExtra = (spec: MeasureSpec) =>
  spec.id === "nfr-03"
    ? { callbacks: filled(spec.count, 3) }
    : { gapsMs: filled(spec.count, GAP_MS) };
const FRAME_PERIOD = { intervals: 600, p50Ms: 17, p95Ms: 18, maxMs: 25 };

function greenBody(spec: MeasureSpec): Record<string, unknown> {
  switch (spec.kind) {
    case "latency":
      return {
        schema: RAW_SCHEMA,
        kind: "latency",
        unit: "ms",
        samples: filled(spec.count, spec.limit / 2),
        ...latencyExtra(spec),
      };
    case "memory":
      return {
        schema: RAW_SCHEMA,
        kind: "memory",
        unit: "Mio",
        launches: filled(spec.count, {
          peakMib: 300,
          samples: 40,
          missedTicks: 0,
          medianReadingMs: 11,
        }),
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
        total: 1000,
        matching: 1000,
        found: true,
        visited: 12,
        chosen: 1,
        element: {
          role: "AXGroup",
          subrole: null,
          readings: [
            { reading: 1, length: 1000, matching: 1000 },
            { reading: 2, length: 1000, matching: 1000 },
            { reading: 3, length: 0, matching: 0 },
          ],
        },
        focused: null,
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
      framePeriods: filled(spec.framedLaunches, FRAME_PERIOD),
      // Every keystroke gap is GAP_MS: the summary is GAP_MS at every rank.
      boundGap: spec.id.startsWith("at-02")
        ? { count: spec.count, p50Ms: GAP_MS, p95Ms: GAP_MS, maxMs: GAP_MS }
        : null,
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
      protocolSha256: createHash("sha256").update(protocol).digest("hex"),
      binarySha256: WITH.binarySha256,
      instrument: { harnessCommit: WITH.harnessCommit, scriptSha256: WITH.scriptSha256 },
      rejectedLaunches: { "session-locked": 0, "display-asleep": 0, "helpers-unattributed": 0 },
      stopped: null,
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
  // The protocol committed at P, when it differs from the repository's.
  protocolText?: string;
}

function repositoryWith(options: Options = {}): string {
  const root = mkdtempSync(join(tmpdir(), "p04-check-report-"));
  scratch.push(root);
  git(root, "init", "-q");
  const committed = options.protocolText ?? protocol;
  write(root, "tools/qualification/p04-tauri/PROTOCOL.md", committed);
  mkdirSync(join(root, "toolchains"), { recursive: true });
  copyFileSync(
    join(repositoryRoot, "toolchains", "notebook-resource-classes.json"),
    join(root, "toolchains", "notebook-resource-classes.json"),
  );
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "protocol");
  const fixture = greenFixture(git(root, "rev-parse", "HEAD"));
  fixture.manifest.protocolSha256 = createHash("sha256").update(committed).digest("hex");
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
            measure: "nfr-03",
            note: spec.note ?? "",
            interruptions: [],
            measuredWith: WITH,
            kind: "latency",
            unit: "ms",
            samples: Array.from({ length: spec.count }, () => spec.limit + 1),
            callbacks: Array.from({ length: spec.count }, () => 7),
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
            measure: "nfr-10",
            note: "notes/00/note-00000.md",
            interruptions: [],
            measuredWith: WITH,
            kind: "memory",
            unit: "Mio",
            launches: Array.from({ length: parameters.nfr10Launches }, () => ({
              peakMib: 501,
              samples: 3,
              missedTicks: 0,
              medianReadingMs: 11,
            })),
          });
        },
      }),
    );
    expect(out).toContain("nfr-10: declared");
    expect(code).toBe(2);
  });

  test("a raw output with fewer samples than the protocol count is incomplete", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.raws.set("raw/at-02-1-mib.json", {
            schema: RAW_SCHEMA,
            measure: "at-02-1-mib",
            note: "notes/00/note-00000.md",
            interruptions: [],
            kind: "latency",
            unit: "ms",
            samples: [1, 2, 3],
            gapsMs: [1, 1, 1],
          });
        },
      }),
    );
    expect(out).toContain("the protocol requires");
    expect(code).toBe(2);
  });

  test("an unavailable measure is incomplete, never green", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.raws.set("raw/accessibility.json", {
            schema: RAW_SCHEMA,
            measure: "accessibility",
            interruptions: [],
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

describe("check-report.ts binds the report to the text measured (PROTOCOL.md section 10.8)", () => {
  test("a protocolSha256 other than PROTOCOL.md at commit P is incomplete", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          fixture.manifest.protocolSha256 = "0".repeat(64);
        },
      }),
    );
    expect(out).toContain("protocolSha256");
    expect(code).toBe(2);
  });

  test("PROTOCOL.md is read at commit P, not in the working tree", () => {
    const root = repositoryWith();
    // An uncommitted edit that would change a threshold of the working tree.
    write(
      root,
      "tools/qualification/p04-tauri/PROTOCOL.md",
      protocol.replace(
        "| AT-02, latence frappe → rendu, aperçu en direct actif, 5 000 lignes | p95 ≤ 16 ms |",
        "| AT-02, latence frappe → rendu, aperçu en direct actif, 5 000 lignes | p95 ≤ 32 ms |",
      ),
    );
    const { code, out } = run(root);
    expect(out).toContain("7 pass, 0 fail");
    expect(code).toBe(0);
  });

  test("a manifest without the SHA-256 of the binary measured is incomplete", () => {
    const { code } = run(
      repositoryWith({
        edit: (fixture) => {
          (fixture.manifest as unknown as Record<string, unknown>).binarySha256 = "";
        },
      }),
    );
    expect(code).toBe(2);
  });

  test("raw outputs swapped between the two AT-02 configurations are incomplete", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          measureOf(fixture, "at-02-5000-lines").raw = "raw/at-02-1-mib.json";
          measureOf(fixture, "at-02-1-mib").raw = "raw/at-02-5000-lines.json";
        },
      }),
    );
    expect(out).toContain("belongs to");
    expect(code).toBe(2);
  });
});

// PROTOCOL.md section 10.1: the frame period (600 intervals) of each launch of
// AT-02 and NFR-03, and the gap observation -> bound per AT-02 configuration.
describe("what section 10.1 makes the report record", () => {
  const withEntry = (id: string, key: string, value: unknown) =>
    run(
      repositoryWith({
        edit: (fixture) => {
          (measureOf(fixture, id) as unknown as Record<string, unknown>)[key] = value;
        },
      }),
    );

  test("an entry without frame periods is incomplete", () => {
    const { code, out } = withEntry("nfr-03", "framePeriods", undefined);
    expect(out).toContain("nfr-03: framePeriods is not recorded");
    expect(code).toBe(2);
  });

  test("one NFR-03 launch without its frame period is incomplete", () => {
    const { code, out } = withEntry("nfr-03", "framePeriods", filled(59, FRAME_PERIOD));
    expect(out).toContain("59 frame periods for 60 launches");
    expect(code).toBe(2);
  });

  test("a frame period on a measure that reads none is incomplete", () => {
    const { code, out } = withEntry("nfr-10", "framePeriods", [FRAME_PERIOD]);
    expect(out).toContain("1 frame periods for 0 launches");
    expect(code).toBe(2);
  });

  test("a frame period of another count of intervals, a missing or disordered statistic, is incomplete", () => {
    for (const period of [
      { ...FRAME_PERIOD, intervals: 599 },
      { intervals: 600, p50Ms: 17, maxMs: 25 },
      { ...FRAME_PERIOD, p50Ms: 19 },
      { ...FRAME_PERIOD, p95Ms: 26 },
      { ...FRAME_PERIOD, p50Ms: -1 },
    ]) {
      const { code, out } = withEntry("at-02-1-mib", "framePeriods", [period]);
      expect(out).toContain("at-02-1-mib: frame period of launch 0");
      expect(code).toBe(2);
    }
  });

  // The count of intervals is frame-period-intervals of PROTOCOL.md at P, not a
  // constant of the verifier: under a protocol that says 599, a period of 600 is refused.
  test("the count of intervals required is the field of the protocol at P", () => {
    const changed = protocol.replace(
      "| `frame-period-intervals` | 600 |",
      "| `frame-period-intervals` | 599 |",
    );
    expect(changed).not.toBe(protocol);
    const { code, out } = run(repositoryWith({ protocolText: changed }));
    expect(out).toContain("is not 599 intervals");
    expect(code).toBe(2);
  });

  test("an AT-02 entry without the gap observation -> bound is incomplete", () => {
    const { code, out } = withEntry("at-02-5000-lines", "boundGap", null);
    expect(out).toContain(
      "at-02-5000-lines: boundGap null differs from the gaps of the raw output",
    );
    expect(code).toBe(2);
  });

  test("a gap summary the raw gaps do not give is incomplete", () => {
    const { code, out } = withEntry("at-02-1-mib", "boundGap", {
      count: parameters.at02Keystrokes,
      p50Ms: GAP_MS,
      p95Ms: GAP_MS,
      maxMs: GAP_MS + 1,
    });
    expect(out).toContain("at-02-1-mib: boundGap");
    expect(code).toBe(2);
  });

  test("a gap summary on a measure other than AT-02 is incomplete", () => {
    const { code, out } = withEntry("nfr-03", "boundGap", {
      count: 1,
      p50Ms: 1,
      p95Ms: 1,
      maxMs: 1,
    });
    expect(out).toContain("nfr-03: boundGap is recorded for AT-02 only");
    expect(code).toBe(2);
  });
});

// PROTOCOL.md section 10.7: three rejections or interruptions of one cause in a row
// stop the series, recorded with that cause and no verdict.
// PROTOCOL.md section 10.7: a corrected instrument or product starts the series
// again; no sample of another binary or instrument enters a verdict.
describe("one binary and one instrument per report (PROTOCOL.md section 10.7)", () => {
  test("a manifest without the identity of the instrument is incomplete", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          (fixture.manifest as unknown as Record<string, unknown>).instrument = undefined;
        },
      }),
    );
    expect(out).toContain("instrument is not the commit of the harness");
    expect(code).toBe(2);
  });

  test("a measure whose samples were made with another binary is incomplete", () => {
    const { code, out } = run(
      repositoryWith({
        edit: (fixture) => {
          const raw = fixture.raws.get("raw/nfr-10.json") as Record<string, unknown>;
          raw.measuredWith = { ...WITH, binarySha256: "d".repeat(64) };
        },
      }),
    );
    expect(out).toContain("nfr-10: measured with");
    expect(code).toBe(2);
  });

  test("a measure whose samples were made with another instrument, or that does not say, is incomplete", () => {
    for (const measuredWith of [
      { ...WITH, scriptSha256: "e".repeat(64) },
      { ...WITH, harnessCommit: "f".repeat(40) },
      undefined,
    ]) {
      const { code, out } = run(
        repositoryWith({
          edit: (fixture) => {
            const raw = fixture.raws.get("raw/at-01-round-trip.json") as Record<string, unknown>;
            raw.measuredWith = measuredWith;
          },
        }),
      );
      expect(out).toContain("at-01-round-trip: measured with");
      expect(code).toBe(2);
    }
  });
});

describe("the stop of the series (PROTOCOL.md section 10.7)", () => {
  const withStopped = (stopped: unknown) =>
    run(
      repositoryWith({
        edit: (fixture) => {
          (fixture.manifest as unknown as Record<string, unknown>).stopped = stopped;
        },
      }),
    );

  test("a stopped series has no verdict, and shell-exited is named a defect of the product", () => {
    const { code, out } = withStopped({
      cause: "shell-exited",
      defect: "product",
      unit: "nfr-03 launch 7",
    });
    expect(out).toContain(
      "the series stopped at nfr-03 launch 7: 3 consecutive shell-exited, a defect of the product",
    );
    expect(code).toBe(2);
  });

  test("a manifest without the stopped field is incomplete", () => {
    const { code, out } = withStopped(undefined);
    expect(out).toContain("stopped is not recorded");
    expect(code).toBe(2);
  });

  test("a cause outside the closed set, or a defect that is not the cause's, is incomplete", () => {
    expect(withStopped({ cause: "window-hidden", defect: "machine", unit: "u" }).out).toContain(
      "outside the closed set",
    );
    expect(withStopped({ cause: "shell-exited", defect: "machine", unit: "u" }).out).toContain(
      "shell-exited is a defect of the product",
    );
  });
});

describe("rejected launches (PROTOCOL.md section 10.7)", () => {
  const withRejected = (rejected: unknown) =>
    run(
      repositoryWith({
        edit: (fixture) => {
          (fixture.manifest as unknown as Record<string, unknown>).rejectedLaunches = rejected;
        },
      }),
    );

  test("a cause outside the closed set is incomplete", () => {
    const { code, out } = withRejected({
      "session-locked": 0,
      "display-asleep": 0,
      "helpers-unattributed": 0,
      other: 1,
    });
    expect(out).toContain("rejectedLaunches");
    expect(code).toBe(2);
  });

  test("a missing cause is incomplete", () => {
    expect(withRejected({ "session-locked": 0, "display-asleep": 0 }).code).toBe(2);
  });

  test("a negative or non-integer count is incomplete", () => {
    expect(
      withRejected({ "session-locked": -1, "display-asleep": 0, "helpers-unattributed": 0 }).code,
    ).toBe(2);
    expect(
      withRejected({ "session-locked": 0.5, "display-asleep": 0, "helpers-unattributed": 0 }).code,
    ).toBe(2);
  });

  test("rejected launches do not change a green verdict", () => {
    expect(
      withRejected({ "session-locked": 3, "display-asleep": 1, "helpers-unattributed": 2 }).code,
    ).toBe(0);
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
