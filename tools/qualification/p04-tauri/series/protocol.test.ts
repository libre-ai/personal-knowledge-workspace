// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FRAME_PERIOD_INTERVALS, measureSpecs, readProtocol, seriesParameters } from "./protocol";

const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const protocol = readProtocol(repositoryRoot);

describe("series parameters come from PROTOCOL.md", () => {
  const parameters = seriesParameters(protocol);

  // Written from PROTOCOL.md sections 1, 2 and 10 (CA-36 counts), not from the code.
  test("counts", () => {
    expect(parameters.at01Passes).toBe(20);
    expect(parameters.at02Keystrokes).toBe(3000);
    expect(parameters.nfr03Launches).toBe(60);
    expect(parameters.nfr10Launches).toBe(60);
    expect(parameters.corpusFiles).toBe(10000);
  });

  test("procedure parameters of section 10", () => {
    expect(parameters.keystrokeTimeoutMs).toBe(2000);
    expect(parameters.memoryCeilingMib).toBe(500);
    expect(parameters.at01EditText).toBe("p04");
    expect(parameters.at02TypedCycle).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(parameters.at02PauseMs).toBe(150);
    expect(parameters.nfr10SamplePeriodMs).toBe(100);
    expect(parameters.nfr10HoldMs).toBe(5000);
    expect(parameters.saveTimeoutMs).toBe(10000);
    expect(parameters.at01KeyGapMs).toBe(20);
  });

  test("the preview delay of the protocol is the one the editor ships", () => {
    const preview = readFileSync(
      join(repositoryRoot, "apps", "desktop", "src", "editor", "preview.ts"),
      "utf8",
    );
    const shipped = /export function livePreview\([^)]*delayMs = (\d+)\)/.exec(preview)?.[1];
    expect(shipped).toBeDefined();
    expect(parameters.previewDelayMs).toBe(Number(shipped));
  });

  test("a missing or non-integer field is refused", () => {
    expect(() => seriesParameters(protocol.replace("| `at-02-pause-ms` | 150 |", ""))).toThrow(
      "at-02-pause-ms",
    );
    expect(() =>
      seriesParameters(
        protocol.replace("| `at-02-pause-ms` | 150 |", "| `at-02-pause-ms` | 1.5 |"),
      ),
    ).toThrow("at-02-pause-ms");
  });
});

describe("the seven thresholds of PROTOCOL.md section 3 are classified", () => {
  const specs = measureSpecs(protocol);

  test("one spec per threshold, in the protocol order", () => {
    expect(specs.map((spec) => spec.id)).toEqual([
      "at-01-round-trip",
      "at-01-paragraph-edit",
      "at-02-5000-lines",
      "at-02-1-mib",
      "nfr-03",
      "nfr-10",
      "accessibility",
    ]);
  });

  test("limits and counts", () => {
    const byId = new Map(specs.map((spec) => [spec.id, spec]));
    expect(byId.get("at-02-5000-lines")).toMatchObject({ kind: "latency", limit: 16, count: 3000 });
    expect(byId.get("at-02-1-mib")).toMatchObject({ kind: "latency", limit: 50, count: 3000 });
    expect(byId.get("nfr-03")).toMatchObject({ kind: "latency", limit: 100, count: 60 });
    expect(byId.get("nfr-10")).toMatchObject({ kind: "memory", limit: 500, count: 60 });
    expect(byId.get("at-01-round-trip")).toMatchObject({ kind: "round-trip", count: 20 });
    expect(byId.get("at-01-paragraph-edit")).toMatchObject({ kind: "paragraph-edit", count: 20 });
    expect(byId.get("accessibility")).toMatchObject({ kind: "accessibility", limit: 100 });
  });

  // PROTOCOL.md sections 10.2 to 10.6: 5 000 lines = note index 1, 1 MiB = note index 0.
  test("each measure names the note it is made on", () => {
    const notes = Object.fromEntries(specs.map((spec) => [spec.id, spec.note]));
    expect(notes).toEqual({
      "at-01-round-trip": null,
      "at-01-paragraph-edit": null,
      "at-02-5000-lines": "notes/01/note-00001.md",
      "at-02-1-mib": "notes/00/note-00000.md",
      "nfr-03": "notes/00/note-00000.md",
      "nfr-10": "notes/00/note-00000.md",
      accessibility: "notes/00/note-00000.md",
    });
  });

  // PROTOCOL.md section 10.1: the frame period is read at the start of each launch
  // of AT-02 and of NFR-03, and of no other.
  test("the launches that read a frame period", () => {
    const framed = Object.fromEntries(specs.map((spec) => [spec.id, spec.framedLaunches]));
    expect(framed).toEqual({
      "at-01-round-trip": 0,
      "at-01-paragraph-edit": 0,
      "at-02-5000-lines": 1,
      "at-02-1-mib": 1,
      "nfr-03": 60,
      "nfr-10": 0,
      accessibility: 0,
    });
  });

  test("the prose of section 10.1 still fixes the 600 intervals of the frame period", () => {
    expect(FRAME_PERIOD_INTERVALS).toBe(600);
    expect(protocol.replace(/\s+/g, " ")).toContain(
      "600 intervalles entre rappels `requestAnimationFrame` successifs",
    );
  });

  test("an unknown threshold row is refused, not skipped", () => {
    const extra = protocol.replace(
      "| Texte d'une note de 1 Mio exposé à l'accessibilité | 100 % |",
      "| Texte d'une note de 1 Mio exposé à l'accessibilité | 100 % |\n| NFR-99, mesure inconnue | p95 ≤ 1 ms |",
    );
    expect(() => measureSpecs(extra)).toThrow("NFR-99");
  });

  test("a memory threshold that differs from memory-ceiling-mib is refused", () => {
    const drifted = protocol.replace(
      "| `memory-ceiling-mib` | 500 |",
      "| `memory-ceiling-mib` | 512 |",
    );
    expect(() => measureSpecs(drifted)).toThrow("memory-ceiling-mib");
  });
});
