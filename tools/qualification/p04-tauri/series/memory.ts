// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// NFR-10 readings (PROTOCOL.md section 10.4): the sum of the RSS of the shell
// and of the three WebKit helpers it makes, which are children of launchd and
// not of the shell, so they are attributed by difference against a table read
// just before the launch.

export const HELPER_NAMES = [
  "com.apple.WebKit.WebContent",
  "com.apple.WebKit.GPU",
  "com.apple.WebKit.Networking",
] as const;

export interface ProcessRow {
  rssKib: number;
  /** Basename of the executable. */
  name: string;
}

export type ProcessTable = Map<number, ProcessRow>;

/** `ps -A -o pid=,rss=,comm=`: the command column is the executable path, spaces included. */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split("\n")) {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const [, pid, rss, command] = match;
    if (pid === undefined || rss === undefined || command === undefined) continue;
    table.set(Number(pid), { rssKib: Number(rss), name: command.trim().split("/").at(-1) ?? "" });
  }
  return table;
}

export type Attribution =
  | { ok: true; pids: number[] }
  | { ok: false; found: Record<string, number> };

/** Exactly one new process of each helper name, or the launch is not a sample. */
export function attributeHelpers(before: ProcessTable, after: ProcessTable): Attribution {
  const pids: number[] = [];
  const found: Record<string, number> = {};
  for (const name of HELPER_NAMES) {
    const born = [...after]
      .filter(([pid, row]) => row.name === name && !before.has(pid))
      .map(([pid]) => pid);
    found[name] = born.length;
    const only = born[0];
    if (born.length === 1 && only !== undefined) pids.push(only);
  }
  return pids.length === HELPER_NAMES.length ? { ok: true, pids } : { ok: false, found };
}

/**
 * The WebKit helpers of `table`: read before the series, they are another
 * application using WebKit, which PROTOCOL.md section 10.4 excludes (it would
 * make helpers of the same names during a launch and break the attribution).
 */
export function webKitHelpers(table: ProcessTable): number[] {
  return [...table]
    .filter(([, row]) => (HELPER_NAMES as readonly string[]).includes(row.name))
    .map(([pid]) => pid);
}

/** Sum of the RSS of `pids`, in Mio (1 Mio = 1 024 KiB). A pid absent from the table is an error. */
export function rssMib(table: ProcessTable, pids: readonly number[]): number {
  let kib = 0;
  for (const pid of pids) {
    const row = table.get(pid);
    if (row === undefined) throw new Error(`memory: process ${pid} is not in the table`);
    kib += row.rssKib;
  }
  return kib / 1024;
}

export function readProcessTable(): ProcessTable {
  const result = Bun.spawnSync(["ps", "-A", "-o", "pid=,rss=,comm="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(`ps failed: ${result.stderr.toString()}`);
  return parseProcessTable(result.stdout.toString());
}
