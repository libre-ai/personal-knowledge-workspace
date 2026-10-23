// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-38, control C6: the Rust process of the shell opens no port. The script
// builds the shell, launches the real binary (window included), and runs
// `lsof -i -P -a -p PID` on its process and every descendant while it lives.
// The instrument is proved on the same run: a TCP listener opened on purpose in
// this process must be seen, otherwise "0 lines" would not mean "no port".
//
// macOS only: the shell is a WKWebView. Elsewhere the script reports
// "unavailable" and fails; it never passes without having looked.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPOSITORY = join(import.meta.dir, "..", "..", "..", "..");
const SETTLE_MS = 6000;
const SAMPLES = 8;
const SAMPLE_EVERY_MS = 500;

interface Reading {
  readonly processes: number;
  readonly lines: readonly string[];
}

/** Throws, so the `finally` that stops the shell always runs. */
function fail(message: string): never {
  throw new Error(message);
}

function run(command: string, args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) fail(`${command}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout };
}

/** The process and its descendants, generations included. */
function processTree(root: number): number[] {
  const table = run("ps", ["-axo", "pid=,ppid="])
    .stdout.split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((columns): columns is [number, number] => columns.length === 2);
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) {
    for (const [pid, parent] of table) {
      if (parent === tree[index] && !tree.includes(pid)) tree.push(pid);
    }
  }
  return tree;
}

/** `lsof -i -P -a -p PID` over the tree. A process lsof cannot read is a failure, not "no port". */
function networkLines(root: number): Reading {
  const lines: string[] = [];
  let processes = 0;
  for (const pid of processTree(root)) {
    const readable = run("lsof", ["-n", "-P", "-p", String(pid)]).stdout.trim();
    if (readable === "") {
      const alive = run("ps", ["-p", String(pid), "-o", "pid="]).stdout.trim() !== "";
      if (pid === root || alive) fail(`lsof cannot read process ${pid}`);
      continue; // a descendant that exited between ps and lsof
    }
    processes += 1;
    const network = run("lsof", ["-n", "-P", "-i", "-a", "-p", String(pid)]).stdout;
    lines.push(...network.split("\n").filter((line) => line !== "" && !line.startsWith("COMMAND")));
  }
  return { processes, lines };
}

function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

if (process.platform !== "darwin") {
  console.error("e2e FAILED: unavailable: the shell runs on macOS (WKWebView)");
  process.exit(1);
}

const build = spawnSync("cargo", ["build", "--locked", "-p", "libre-ai-p04-desktop"], {
  cwd: REPOSITORY,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("e2e FAILED: cargo build failed");
  process.exit(1);
}

const binary = join(
  process.env.CARGO_TARGET_DIR ?? join(REPOSITORY, "target"),
  "debug",
  "libre-ai-p04-desktop",
);
// WebKit keeps its data under `~`: a scratch home keeps this run out of the user's.
const home = mkdtempSync(join(tmpdir(), "p04-e2e-home-"));
const shell = spawn(binary, [], {
  env: { ...process.env, CFFIXED_USER_HOME: home },
  stdio: "ignore",
});
const exited = exitOf(shell);
let early: number | null = null;
shell.once("exit", (code) => {
  early = code ?? -1;
});

try {
  await Bun.sleep(SETTLE_MS);
  if (early !== null) fail(`the shell exited by itself with code ${early}`);
  const pid = shell.pid;
  if (pid === undefined) fail("the shell has no pid");

  let listening = 0;
  let lineCount = 0;
  let processReadings = 0;
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    const reading = networkLines(pid);
    lineCount += reading.lines.length;
    listening += reading.lines.filter((line) => line.includes("(LISTEN)")).length;
    processReadings += reading.processes;
    await Bun.sleep(SAMPLE_EVERY_MS);
  }
  console.log(
    `C6 shell: lsof -i -P -a -p ${processReadings} lecture(s) de processus sur ${SAMPLES} echantillon(s) : ${lineCount} ligne(s), ${listening} en ecoute`,
  );
  if (processReadings < SAMPLES)
    fail("fewer process readings than samples: the shell was not read");
  if (lineCount !== 0) fail(`${lineCount} network line(s) for the shell, expected 0`);

  // Red vector: a listener opened on purpose in this process must make the same reading non-zero.
  const deliberate = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const own = networkLines(process.pid);
  deliberate.stop(true);
  const ownListening = own.lines.filter((line) => line.includes("(LISTEN)")).length;
  console.log(
    `C6 vecteur rouge (ecouteur volontaire): ${own.lines.length} ligne(s) dont ${ownListening} en ecoute`,
  );
  if (ownListening < 1) fail("the deliberate listener was not seen: lsof proves nothing");
  console.log("e2e: OK");
} catch (error) {
  console.error(`e2e FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  shell.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(5000)]);
  if (shell.exitCode === null) shell.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
}
