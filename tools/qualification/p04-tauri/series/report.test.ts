// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluate, type RawBody } from "./evaluate";
import type { MachineRecord } from "./manifest";
import { type MeasureSpec, measureSpecs, readProtocol, seriesParameters } from "./protocol";
import { framePeriodOf, manifestOf, measuredWithOf, rawOf } from "./report";

const WITH = {
  binarySha256: "a".repeat(64),
  harnessCommit: "b".repeat(40),
  scriptSha256: "c".repeat(64),
};

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const specs = measureSpecs(readProtocol(repositoryRoot));
const parameters = seriesParameters(readProtocol(repositoryRoot));
const scratch = mkdtempSync(join(tmpdir(), "p04-report-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

describe("a raw output written by the harness carries its identity (review of #46, point 5)", () => {
  test("each measure's raw output names the measure and its note, and evaluate accepts it", () => {
    // A body of the measure's kind with no sample: evaluate gets past the identity
    // checks and stops on the count, so a wrong identity would show in the issue.
    const empty: Record<MeasureSpec["kind"], RawBody> = {
      latency: { kind: "latency", unit: "ms", samples: [], gapsMs: [] },
      memory: { kind: "memory", unit: "Mio", launches: [] },
      "round-trip": { kind: "round-trip", passes: [] },
      "paragraph-edit": { kind: "paragraph-edit", editableFiles: 1, passes: [] },
      accessibility: {
        kind: "accessibility",
        total: 0,
        matching: 0,
        found: false,
        visited: 0,
        chosen: null,
        element: null,
        focused: null,
      },
    };
    for (const spec of specs) {
      const raw = rawOf(spec, empty[spec.kind], [], WITH);
      expect(raw.measure).toBe(spec.id);
      expect(raw.note).toBe(spec.note ?? undefined);
      const evaluation = evaluate(spec, raw);
      expect(evaluation.ok).toBe(false);
      if (!evaluation.ok) {
        expect(evaluation.issue).not.toContain("belongs to");
        expect(evaluation.issue).not.toContain("was made on");
        expect(evaluation.issue).not.toContain("interruptions");
      }
    }
  });

  test("the interruptions of the measure are carried by its raw output", () => {
    const spec = specs[0];
    if (spec === undefined) throw new Error("no spec");
    const interruptions = [
      { unit: "at-01 pass 0", attempt: 1, cause: "page-hidden" as const, reason: "window hidden" },
    ];
    expect(
      rawOf(spec, { kind: "unavailable", reason: "x" }, interruptions, WITH).interruptions,
    ).toEqual(interruptions);
  });

  // PROTOCOL.md section 10.7: the samples of a measure carry the identity of their run.
  test("the binary and the instrument of the run are carried by the raw output", () => {
    const spec = specs[0];
    if (spec === undefined) throw new Error("no spec");
    expect(rawOf(spec, { kind: "unavailable", reason: "x" }, [], WITH).measuredWith).toEqual(WITH);
  });
});

describe("the frame period reported at the start of a launch (PROTOCOL.md section 10.1)", () => {
  const intervals = parameters.framePeriodIntervals;

  test("a report of frame-period-intervals intervals is kept as it is", () => {
    const event = { seq: 9, type: "frames", intervals, p50Ms: 17, p95Ms: 18, maxMs: 25 };
    expect(framePeriodOf(event, intervals)).toEqual({ intervals, p50Ms: 17, p95Ms: 18, maxMs: 25 });
  });

  test("the count required is the one given by the protocol, not a constant", () => {
    const event = { intervals: 599, p50Ms: 17, p95Ms: 18, maxMs: 25 };
    expect(framePeriodOf(event, 599)).toEqual(event);
    expect(() => framePeriodOf({ ...event, intervals: 600 }, 599)).toThrow(
      "the protocol reads 599",
    );
  });

  test("another count of intervals, or a missing statistic, is an instrument error", () => {
    expect(() =>
      framePeriodOf({ intervals: intervals - 1, p50Ms: 17, p95Ms: 18, maxMs: 25 }, intervals),
    ).toThrow(`the protocol reads ${intervals}`);
    expect(() =>
      framePeriodOf({ intervals, p50Ms: 17, p95Ms: null, maxMs: 25 }, intervals),
    ).toThrow("incomplete frame period");
  });
});

describe("the manifest names the protocol text and the binary measured (review of #46, point 1)", () => {
  const machine: MachineRecord = {
    class: "fixture",
    operatingSystem: "darwin",
    architecture: "arm64",
    hardwareModel: "fixture",
    processor: "fixture",
    memoryBytes: 1,
    logicalCpu: 1,
    hypervisorPresent: false,
    osVersion: "fixture",
  };

  test("binarySha256 is the SHA-256 of the bytes of the binary, protocolSha256 of the protocol read", () => {
    const binary = join(scratch, "p04_series");
    writeFileSync(binary, "a binary of the fixture");
    const protocolBytes = new TextEncoder().encode("# protocol of the fixture\n");
    const measuredWith = measuredWithOf(binary, "2".repeat(40), "3".repeat(64));
    expect(measuredWith.binarySha256).toBe(sha256("a binary of the fixture"));
    const manifest = manifestOf({
      trial: false,
      commit: "0".repeat(40),
      machine,
      corpusSha256: "1".repeat(64),
      protocolBytes,
      measuredWith,
      rejectedLaunches: { "session-locked": 0, "display-asleep": 0, "helpers-unattributed": 0 },
      stopped: { cause: "page-hidden", defect: "machine", unit: "nfr-03 launch 2" },
      measures: [],
      createdAt: new Date("2026-10-24T00:00:00Z"),
    });
    expect(manifest.binarySha256).toBe(sha256("a binary of the fixture"));
    expect(manifest.instrument).toEqual({
      harnessCommit: "2".repeat(40),
      scriptSha256: "3".repeat(64),
    });
    expect(manifest.protocolSha256).toBe(sha256(protocolBytes));
    expect(manifest.stopped).toEqual({
      cause: "page-hidden",
      defect: "machine",
      unit: "nfr-03 launch 2",
    });
    expect(manifest.createdAt).toBe("2026-10-24T00:00:00.000Z");
  });
});
