// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// One launch of the shell with the rejection rule of PROTOCOL.md section 10.7:
// a launch made with a locked session or a switched-off screen is rejected and
// redone, as is one whose body cannot attribute the WebKit helpers (section
// 10.4). The order of the reads is the protocol's: the rejection read, then the
// process table "before" as the last operation before the shell process is
// created, which also follows the exit of the previous launch's process. Each
// rejection counts towards the streak that stops the series (`attempts.ts`).

import { type Streak, Unavailable } from "./attempts";
import type { RejectionCause } from "./manifest";
import type { ProcessTable } from "./memory";

/** What a launch body returns when its launch is not a sample and is redone. */
export class Rejected {
  constructor(readonly cause: RejectionCause) {}
}

export interface LaunchSteps<L extends { stop(): Promise<void> }> {
  rejection(): RejectionCause | null;
  readTable(): ProcessTable;
  launch(): L;
  /** Waits before the next read when the session is locked or the screen off. */
  pause(): Promise<void>;
}

/** shortcut: a bound of the harness for alternating causes; upgrade trigger: a series reaching it. */
export const MAX_REJECTIONS = 10;

export async function withLaunch<T, L extends { stop(): Promise<void> }>(
  steps: LaunchSteps<L>,
  context: { rejected: Record<RejectionCause, number>; streak: Streak; unit: string },
  body: (shell: L, before: ProcessTable) => Promise<T | Rejected>,
  maxRejections: number = MAX_REJECTIONS,
): Promise<T> {
  const reject = (cause: RejectionCause): void => {
    context.rejected[cause] += 1;
    context.streak.record(cause, context.unit);
  };
  for (let attempt = 0; attempt < maxRejections; attempt += 1) {
    const cause = steps.rejection();
    if (cause !== null) {
      reject(cause);
      await steps.pause();
      continue;
    }
    const before = steps.readTable();
    const shell = steps.launch();
    let result: T | Rejected;
    try {
      result = await body(shell, before);
      const after = steps.rejection();
      if (after !== null) result = new Rejected(after);
    } finally {
      await shell.stop();
    }
    if (result instanceof Rejected) {
      reject(result.cause);
      continue;
    }
    return result;
  }
  throw new Unavailable(`${context.unit}: ${maxRejections} launches rejected`);
}
