// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Builds and launches the series binary (`apps/desktop/src-tauri/examples/p04_series.rs`)
// and reads the reports of its instrumentation script, one stdout line per
// document title. Launch patterns follow `apps/desktop/tests/shell/e2e.ts`
// (scratch home for WebKit, stop in a finally); that file runs as a script and
// does not import.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPORT_PREFIX } from "./instrument";

export interface SeriesEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export function parseEventLine(line: string): SeriesEvent | null {
  if (!line.startsWith(REPORT_PREFIX)) return null;
  const parsed: unknown = JSON.parse(line.slice(REPORT_PREFIX.length));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("series: a report is not an object");
  const event = parsed as Record<string, unknown>;
  if (typeof event.seq !== "number" || typeof event.type !== "string") {
    throw new Error("series: a report has no seq or type");
  }
  return event as SeriesEvent;
}

/** Titles are numbered from 0 by the script: a gap means a title was lost. */
export class SequenceGuard {
  #next = 0;
  accept(event: SeriesEvent): void {
    if (event.seq !== this.#next)
      throw new Error(`series: seq ${event.seq} received, ${this.#next} expected`);
    this.#next += 1;
  }
}

function run(argv: string[], cwd: string): void {
  const result = Bun.spawnSync(argv, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed`);
}

/** Front first (it is embedded at build time), then the release build of the example. */
export function buildSeriesBinary(repository: string): string {
  run(["bun", "run", "--cwd", "apps/desktop", "build"], repository);
  run(
    [
      "cargo",
      "build",
      "--locked",
      "--release",
      "-p",
      "libre-ai-p04-desktop",
      "--example",
      "p04_series",
    ],
    repository,
  );
  return join(
    process.env.CARGO_TARGET_DIR ?? join(repository, "target"),
    "release",
    "examples",
    "p04_series",
  );
}

export interface Launched {
  readonly pid: number;
  /** The next report of the script; an `error` report or the end of the process rejects. */
  next(timeoutMs: number): Promise<SeriesEvent>;
  readonly exited: Promise<number>;
  stop(): Promise<void>;
}

export function launchShell(binary: string, vault: string, script: string): Launched {
  const scratch = mkdtempSync(join(tmpdir(), "p04-series-shell-"));
  const scriptPath = join(scratch, "instrument.js");
  writeFileSync(scriptPath, script);
  // WebKit keeps its data under `~`: a scratch home keeps the series out of the user's.
  const home = join(scratch, "home");
  const child = Bun.spawn([binary, "--vault", vault, "--script", scriptPath], {
    env: { ...process.env, CFFIXED_USER_HOME: home },
    stdout: "pipe",
    stderr: "inherit",
  });
  const guard = new SequenceGuard();
  const events: SeriesEvent[] = [];
  const waiters: ((event: SeriesEvent | Error) => void)[] = [];
  let failure: Error | null = null;
  const deliver = (item: SeriesEvent | Error): void => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(item);
    else if (item instanceof Error) failure ??= item;
    else events.push(item);
  };
  const reading = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          const event = parseEventLine(line);
          if (event !== null) {
            guard.accept(event);
            deliver(
              event.type === "error" ? new Error(`series script: ${String(event.reason)}`) : event,
            );
          }
        } catch (error) {
          deliver(error instanceof Error ? error : new Error(String(error)));
        }
        newline = pending.indexOf("\n");
      }
    }
  })();
  const exited = child.exited.then(async (code) => {
    await reading;
    deliver(new Error(`series: the shell exited with code ${code}`));
    return code;
  });
  return {
    pid: child.pid,
    exited,
    next(timeoutMs: number): Promise<SeriesEvent> {
      const queued = events.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (failure !== null) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(settle);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`series: no report within ${timeoutMs} ms`));
        }, timeoutMs);
        const settle = (item: SeriesEvent | Error): void => {
          clearTimeout(timer);
          if (item instanceof Error) reject(item);
          else resolve(item);
        };
        waiters.push(settle);
      });
    },
    async stop(): Promise<void> {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** Waits for the next report of `type`; any other type in between is an instrument error. */
export async function expectEvent(
  shell: Launched,
  type: string,
  timeoutMs: number,
): Promise<SeriesEvent> {
  for (;;) {
    const event = await shell.next(timeoutMs);
    if (event.type === type) return event;
    if (event.type === "progress" || event.type === "index") continue;
    throw new Error(`series: report ${event.type} received, ${type} expected`);
  }
}
