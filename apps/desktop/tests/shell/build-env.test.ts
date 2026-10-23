// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-37, controls C2 to C5: the static gate reads the tracked files, and
// `tauri-build` also merges the TAURI_CONFIG environment variable into the
// configuration. A build under that variable is a different shell from the one
// the gate judged. These tests run the real build script (`cargo check` runs it)
// under each variable and require it to refuse.
//
// Needs `apps/desktop/dist` (`bun run --cwd apps/desktop build`) and a Rust
// toolchain: it belongs to `check:p04-shell`, not to the Linux `check` lane.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { refusedEnvironment } from "./controls";

const REPOSITORY = join(import.meta.dir, "..", "..", "..", "..");
const SHELL_DIRECTORY = join(import.meta.dir, "..", "..", "src-tauri");
const REFUSE_ENV_SCRIPT = join(import.meta.dir, "refuse-env.ts");
const BUILD_TIMEOUT_MS = 900_000;

/** What a child needs to find its toolchain; everything else is dropped (`env -i`), so an ambient TAURI_* cannot reach the probe. */
const KEPT = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "LANG",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "CARGO_TARGET_DIR",
];

function cleanEnvironment(extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of KEPT) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...extra };
}

function cargoCheck(extra: Record<string, string>) {
  const result = spawnSync("cargo", ["check", "--locked", "-p", "libre-ai-p04-desktop"], {
    cwd: REPOSITORY,
    env: cleanEnvironment(extra),
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
  });
  return { status: result.status, stderr: result.stderr ?? "", error: result.error };
}

interface Vector {
  readonly name: string;
  readonly variable: string;
  readonly value: string;
}

// The two reproductions of the review of PR 34, plus the variable set but empty.
const VECTORS: readonly Vector[] = [
  {
    name: "TAURI_CONFIG removes the CSP",
    variable: "TAURI_CONFIG",
    value: '{"app":{"security":{"csp":null}}}',
  },
  {
    name: "TAURI_CONFIG compiles an inline capability on every window with core:default",
    variable: "TAURI_CONFIG",
    value:
      '{"app":{"security":{"capabilities":["main",{"identifier":"injected","windows":["*"],"permissions":["core:default"]}]}}}',
  },
  { name: "TAURI_CONFIG is set but empty", variable: "TAURI_CONFIG", value: "" },
];

describe("build.rs builds the shell only from the files the gate read", () => {
  test(
    "positive control: without any variable the build script passes",
    () => {
      const build = cargoCheck({});
      console.log(`no variable: cargo check exit ${String(build.status)}`);
      expect(build.error).toBeUndefined();
      expect(build.status).toBe(0);
    },
    BUILD_TIMEOUT_MS,
  );

  for (const vector of VECTORS) {
    test(
      `${vector.name}: the build is refused and says why`,
      () => {
        const build = cargoCheck({ [vector.variable]: vector.value });
        console.log(`${vector.name}: cargo check exit ${String(build.status)}`);
        expect(build.error).toBeUndefined();
        expect(build.status).not.toBe(0);
        expect(build.stderr).toContain(vector.variable);
        expect(build.stderr).toContain("C2");
        expect(build.stderr).toContain("C5");
      },
      BUILD_TIMEOUT_MS,
    );
  }
});

describe("the chain refuses the same variables before its first cargo step", () => {
  const buildScript = readFileSync(join(SHELL_DIRECTORY, "build.rs"), "utf8");

  test("the list read from build.rs names TAURI_CONFIG", () => {
    expect(refusedEnvironment(buildScript)).toContain("TAURI_CONFIG");
  });

  test("a defined variable of the list fails the step and is named", () => {
    const step = spawnSync(process.execPath, [REFUSE_ENV_SCRIPT], {
      env: cleanEnvironment({ TAURI_CONFIG: "{}" }),
      encoding: "utf8",
    });
    expect(step.status).not.toBe(0);
    expect(step.stderr).toContain("TAURI_CONFIG");
  });

  test("the empty value is a definition too", () => {
    const step = spawnSync(process.execPath, [REFUSE_ENV_SCRIPT], {
      env: cleanEnvironment({ TAURI_CONFIG: "" }),
      encoding: "utf8",
    });
    expect(step.status).not.toBe(0);
  });

  test("a clean environment passes and prints its count", () => {
    const step = spawnSync(process.execPath, [REFUSE_ENV_SCRIPT], {
      env: cleanEnvironment({}),
      encoding: "utf8",
    });
    expect(step.status).toBe(0);
    expect(step.stdout).toContain(`${refusedEnvironment(buildScript).length} variable(s) refused`);
    expect(step.stdout).toContain("0 defined");
  });
});
