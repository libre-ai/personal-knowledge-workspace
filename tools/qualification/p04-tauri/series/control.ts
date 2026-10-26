// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The start-bound control of PROTOCOL.md section 10.2: the page signals, then
// blocks its main thread `timestamp-control-block-ms`; a keystroke posted at the
// signal must measure at least `timestamp-control-min-latency-ms`, which only a
// timestamp taken from the platform event gives. If it fails, the series does
// not start and no other start bound is substituted: the measure is unavailable.

import { Unavailable } from "./attempts";
import type { SeriesParameters } from "./protocol";

export function checkStartBoundControl(
  latency: unknown,
  parameters: Pick<SeriesParameters, "timestampControlBlockMs" | "timestampControlMinLatencyMs">,
): number {
  if (typeof latency !== "number" || latency < parameters.timestampControlMinLatencyMs) {
    throw new Unavailable(
      `start-bound control failed: ${String(latency)} ms for a ${parameters.timestampControlBlockMs} ms block, at least ${parameters.timestampControlMinLatencyMs} ms required`,
    );
  }
  return latency;
}
