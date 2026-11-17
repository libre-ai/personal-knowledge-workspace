// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { isTrial, parseOptions } from "./options";

describe("options of run.ts", () => {
  test("--out alone is a full run", () => {
    const options = parseOptions(["--out", "reports/x"]);
    expect(options).toEqual({ out: resolve("reports/x"), trial: null, only: null, binary: null });
    expect(isTrial(options)).toBe(false);
  });

  test("--trial and --only make a trial", () => {
    expect(isTrial(parseOptions(["--out", "x", "--trial", "2"]))).toBe(true);
    expect(isTrial(parseOptions(["--out", "x", "--only", "nfr-03"]))).toBe(true);
  });

  // A binary other than the one built from the commit measures something the
  // commit does not name: like --only, it forces a trial, which check-report.ts refuses.
  test("--binary makes a trial", () => {
    const options = parseOptions(["--out", "x", "--binary", "target/p04_series"]);
    expect(options.binary).toBe(resolve("target/p04_series"));
    expect(isTrial(options)).toBe(true);
  });

  test("an unknown option, a missing value or a missing --out is refused", () => {
    expect(() => parseOptions(["--out", "x", "--fast", "1"])).toThrow("unknown option");
    expect(() => parseOptions(["--out"])).toThrow("needs a value");
    expect(() => parseOptions(["--trial", "2"])).toThrow("--out DIR is required");
    expect(() => parseOptions(["--out", "x", "--trial", "0"])).toThrow();
  });
});
