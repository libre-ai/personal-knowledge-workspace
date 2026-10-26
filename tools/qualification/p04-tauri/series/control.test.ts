// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Unavailable } from "./attempts";
import { checkStartBoundControl } from "./control";
import { readProtocol, seriesParameters } from "./protocol";

const parameters = seriesParameters(readProtocol(join(import.meta.dir, "..", "..", "..", "..")));

// PROTOCOL.md section 10.2: the minimum comes from timestamp-control-min-latency-ms.
describe("the start-bound control", () => {
  test("a latency at the minimum of the protocol holds", () => {
    const minimum = parameters.timestampControlMinLatencyMs;
    expect(checkStartBoundControl(minimum, parameters)).toBe(minimum);
  });

  test("one millisecond under it, or no latency, makes the measure unavailable", () => {
    const minimum = parameters.timestampControlMinLatencyMs;
    expect(() => checkStartBoundControl(minimum - 1, parameters)).toThrow(Unavailable);
    expect(() => checkStartBoundControl(null, parameters)).toThrow(Unavailable);
  });

  test("the minimum is the one given, not a constant of the harness", () => {
    const other = { timestampControlBlockMs: 900, timestampControlMinLatencyMs: 400 };
    expect(() => checkStartBoundControl(399, other)).toThrow("400 ms required");
    expect(checkStartBoundControl(400, other)).toBe(400);
  });
});
