// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// CA-37: the configuration of the shell holds the static controls of EF-P04-8.
// The red vectors were written before the configuration they judge: each one
// mutates a copy of the real configuration and must be refused by its control.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type Capability,
  type Control,
  checkShell,
  type Json,
  readShellFiles,
  refusedEnvironment,
  type ShellFiles,
} from "./controls";

const SHELL_DIRECTORY = join(import.meta.dir, "..", "..", "src-tauri");
const shell = readShellFiles(SHELL_DIRECTORY);

type Mutable = { [key: string]: Json };

function asObject(value: Json | undefined): Mutable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected an object in the shell configuration");
  }
  return value;
}

interface Vector {
  readonly name: string;
  readonly control: Control;
  readonly mutate: (files: {
    config: Mutable;
    capabilities: Capability[];
    commands: string[];
  }) => void;
}

function mainWindow(config: Mutable): Mutable {
  const windows = asObject(config.app).windows;
  const first = Array.isArray(windows) ? windows[0] : undefined;
  return asObject(first);
}

function csp(config: Mutable): Mutable {
  return asObject(asObject(asObject(config.app).security).csp);
}

function firstCapability(capabilities: Capability[]): Mutable {
  return asObject(capabilities[0]?.body);
}

const VECTORS: readonly Vector[] = [
  {
    name: "an https:// URL is added to the configuration",
    control: "C1",
    mutate: ({ config }) => {
      config.productName = "https://attacker.example.test/front";
    },
  },
  {
    name: "a window loads a remote front",
    control: "C1",
    mutate: ({ config }) => {
      mainWindow(config).url = "https://attacker.example.test/";
    },
  },
  {
    name: "the front is a development server in the release configuration",
    control: "C1",
    mutate: ({ config }) => {
      asObject(config.build).devUrl = "http://localhost:1420";
    },
  },
  {
    name: "frontendDist leaves the bundle",
    control: "C1",
    mutate: ({ config }) => {
      asObject(config.build).frontendDist = "../../../elsewhere/dist";
    },
  },
  {
    name: "a capability grants rights to a remote origin",
    control: "C2",
    mutate: ({ capabilities }) => {
      firstCapability(capabilities).remote = { urls: ["https://attacker.example.test"] };
    },
  },
  {
    name: "a CSP directive is outside the list",
    control: "C3",
    mutate: ({ config }) => {
      csp(config)["frame-src"] = "'self'";
    },
  },
  {
    name: "a CSP source widens past the private scheme",
    control: "C3",
    mutate: ({ config }) => {
      csp(config)["script-src"] = "'self' 'unsafe-inline'";
    },
  },
  {
    name: "default-src is no longer 'none'",
    control: "C3",
    mutate: ({ config }) => {
      csp(config)["default-src"] = "'self'";
    },
  },
  {
    name: "connect-src names a remote host",
    control: "C3",
    mutate: ({ config }) => {
      csp(config)["connect-src"] = "ipc: http://ipc.localhost https://api.example.test";
    },
  },
  {
    name: "a window is not incognito",
    control: "C4",
    mutate: ({ config }) => {
      mainWindow(config).incognito = false;
    },
  },
  {
    name: "a window names a persistent store",
    control: "C4",
    mutate: ({ config }) => {
      mainWindow(config).dataStoreIdentifier = [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      ];
    },
  },
  {
    name: "a capability is a wildcard",
    control: "C5",
    mutate: ({ capabilities }) => {
      asObject(capabilities[0]?.body).permissions = ["*"];
    },
  },
  {
    name: "a capability opens the core default group",
    control: "C5",
    mutate: ({ capabilities }) => {
      const body = firstCapability(capabilities);
      body.permissions = [...(body.permissions as string[]), "core:default"];
    },
  },
  {
    name: "a capability targets every window",
    control: "C5",
    mutate: ({ capabilities }) => {
      firstCapability(capabilities).windows = ["*"];
    },
  },
  {
    name: "a permission opens a command that build.rs does not declare",
    control: "C5",
    mutate: ({ capabilities }) => {
      const body = firstCapability(capabilities);
      body.permissions = [...(body.permissions as string[]), "allow-undeclared-command"];
    },
  },
  {
    name: "a declared command has no permission",
    control: "C5",
    mutate: ({ commands }) => {
      commands.push("orphan_command");
    },
  },
];

function mutated(vector: Vector): ShellFiles {
  const files = {
    config: structuredClone(shell.config) as Mutable,
    capabilities: structuredClone(shell.capabilities) as Capability[],
    commands: [...shell.commands],
  };
  vector.mutate(files);
  return files;
}

function count(control: Control, report: ReturnType<typeof checkShell>): number {
  return report.refusals.filter((refusal) => refusal.control === control).length;
}

describe("the shipped configuration holds the static controls", () => {
  const report = checkShell(shell.config, shell.capabilities, shell.commands);

  for (const control of ["C1", "C2", "C3", "C4", "C5"] as const) {
    test(`${control}: nothing is refused and something is examined`, () => {
      const refused = count(control, report);
      console.log(
        `${control}: ${refused} refus sur ${report.examined[control]} element(s) examine(s)`,
      );
      expect(report.examined[control]).toBeGreaterThan(0);
      expect(refused).toBe(0);
    });
  }
});

describe("red vectors: each violation of a control is refused and counted", () => {
  for (const vector of VECTORS) {
    test(`${vector.control}: ${vector.name}`, () => {
      const files = mutated(vector);
      const report = checkShell(files.config, files.capabilities, files.commands);
      const refused = count(vector.control, report);
      console.log(`${vector.control} vector "${vector.name}": ${refused} refus`);
      expect(refused).toBeGreaterThan(0);
    });
  }

  test("every control has at least one vector", () => {
    const covered = new Set(VECTORS.map((vector) => vector.control));
    console.log(`vectors: ${VECTORS.length} for ${covered.size} controls`);
    expect([...covered].sort()).toEqual(["C1", "C2", "C3", "C4", "C5"]);
  });
});

describe("the build script refuses the variables that rewrite the configuration", () => {
  // Tauri merges TAURI_CONFIG into the configuration at build time; the files read
  // above are then not what is built. The dynamic proof is `build-env.test.ts`.
  const refused = refusedEnvironment(readFileSync(join(SHELL_DIRECTORY, "build.rs"), "utf8"));

  test("TAURI_CONFIG is on the list of build.rs", () => {
    console.log(`REFUSED_ENV: ${refused.length} variable(s): ${refused.join(", ")}`);
    expect(refused).toContain("TAURI_CONFIG");
  });

  test("a build script without the list refuses nothing, which the test above rejects", () => {
    expect(refusedEnvironment("const REFUSED_ENV: &[&str] = &[];")).toEqual([]);
    expect(refusedEnvironment("fn main() {}")).toEqual([]);
  });
});

describe("a source that cannot be read is a failure, not an empty pass", () => {
  test("an empty shell directory throws", () => {
    const empty = mkdtempSync(join(tmpdir(), "empty-shell-"));
    expect(() => readShellFiles(empty)).toThrow();
  });
});
