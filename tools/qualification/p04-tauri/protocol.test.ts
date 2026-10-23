// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prdSeriesThresholds, protocolFields, protocolThresholds } from "./protocol-fields";

const repositoryRoot = join(import.meta.dir, "..", "..", "..");
const protocol = readFileSync(join(import.meta.dir, "PROTOCOL.md"), "utf8");
const prd = readFileSync(join(repositoryRoot, "docs", "prd.md"), "utf8");
const resourceClasses = JSON.parse(
  readFileSync(join(repositoryRoot, "toolchains", "notebook-resource-classes.json"), "utf8"),
) as { classes: { id: string }[] };

const fields = protocolFields(protocol);

// The expected values below are the figures of CA-36 in
// docs/cahier-des-charges.md, written out so that a drift of PROTOCOL.md from
// the criterion fails here and not only against itself.
const fixedFields: [string, string][] = [
  ["at-01-passes", "20"],
  ["at-02-keystrokes-per-configuration", "3000"],
  ["nfr-03-launches", "60"],
  ["nfr-10-launches", "60"],
  ["percentile", "p95"],
  ["keystroke-timeout-ms", "2000"],
  ["keystroke-timeout-verdict", "+oo"],
  ["machine-class", "desktop-arm64-high-memory-reference"],
  ["memory-ceiling-mib", "500"],
];

describe("PROTOCOL.md fields (CA-36)", () => {
  for (const [key, value] of fixedFields) {
    test(`${key} is ${value}`, () => {
      expect(fields.get(key)).toBe(value);
    });
  }

  test("the percentile is the nearest rank on pooled samples", () => {
    expect(fields.get("percentile-method")).toContain("rang le plus proche");
    expect(fields.get("percentile-method")).toContain("poolés");
  });

  test("a launch made with a locked session or a switched-off screen is rejected and redone", () => {
    const rule = fields.get("launch-rejected-when") ?? "";
    expect(rule).toContain("session verrouillée");
    expect(rule).toContain("écran éteint");
    expect(rule).toContain("refait");
  });

  test("the measurement machine is a class of the resource-class manifest", () => {
    const ids = resourceClasses.classes.map((entry) => entry.id);
    expect(ids).toContain(fields.get("machine-class") ?? "");
  });

  test("the corpus is identified by a SHA-256 and a seed", () => {
    expect(fields.get("corpus-sha256")).toMatch(/^[0-9a-f]{64}$/);
    expect(fields.get("corpus-seed")).toMatch(/^0x[0-9a-f]+$/);
    expect(fields.get("corpus-files")).toBe("10000");
  });

  test("the accessibility method names the macOS accessibility API and the exposed share", () => {
    const method = fields.get("accessibility-method") ?? "";
    expect(method).toContain("API d'accessibilité macOS");
    expect(method).toContain("proportion du texte exposé");
  });
});

describe("PROTOCOL.md thresholds equal docs/prd.md section 5 (CA-36)", () => {
  const expected = prdSeriesThresholds(prd);
  const actual = protocolThresholds(protocol);

  test("the PRD table yields the seven measures of the series", () => {
    expect(expected.length).toBe(7);
  });

  test("the protocol carries exactly those measures, in the same words", () => {
    expect(actual.map((row) => row.measure)).toEqual(expected.map((row) => row.measure));
  });

  for (const row of expected) {
    test(`threshold of: ${row.measure}`, () => {
      expect(actual.find((entry) => entry.measure === row.measure)?.threshold).toBe(row.threshold);
    });
  }

  test("the memory ceiling field is the NFR-10 threshold of the PRD", () => {
    const nfr10 = expected.find((row) => row.measure.startsWith("NFR-10"));
    expect(nfr10?.threshold).toContain(`≤ ${fields.get("memory-ceiling-mib")} Mio`);
  });
});
