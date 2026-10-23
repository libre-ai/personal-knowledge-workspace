// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2
//
// Static half of the six shell controls of ADR-0057 section 2 (EF-P04-8, CA-37).
// The checker reads the files that configure the shell; it never launches it.
// Every control reports what it examined: zero examined elements is a failure,
// never a green (docs/method/TAURI-SHELL.md of project-governance, section 3.1).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type Control = "C1" | "C2" | "C3" | "C4" | "C5";

export interface Refusal {
  readonly control: Control;
  readonly detail: string;
}

export interface Capability {
  readonly file: string;
  readonly body: Json;
}

export interface ControlReport {
  readonly examined: Readonly<Record<Control, number>>;
  readonly refusals: readonly Refusal[];
}

/** Sources a directive may carry. `'self'` is the origin of the private scheme of the shell. */
const PRIVATE_SCHEME_SOURCES: readonly string[] = ["'none'", "'self'"];
/** The only sources Tauri documents for the IPC bridge, the one extra `connect-src` allows. */
const IPC_SOURCES: readonly string[] = ["ipc:", "http://ipc.localhost"];
const ALLOWED_DIRECTIVES: readonly string[] = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "connect-src",
];

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const REMOTE_URL = /^(?:https?|wss?|ftp):\/\//i;
const ALLOW_PERMISSION = /^allow-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every string of the document, `$schema` excepted: it is an editor URL, not an origin the shell contacts. */
export function stringsOf(value: Json | undefined, found: string[] = []): string[] {
  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) stringsOf(item, found);
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key !== "$schema") stringsOf(item, found);
    }
  }
  return found;
}

function section(root: JsonObject, ...path: string[]): Json | undefined {
  let current: Json | undefined = root;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function windowsOf(config: JsonObject): JsonObject[] {
  const windows = section(config, "app", "windows");
  return Array.isArray(windows) ? windows.filter(isObject) : [];
}

/** C1 and C2: the front is an embedded folder and nothing names a remote origin. */
function checkRemote(config: JsonObject, capabilities: readonly Capability[]) {
  const refusals: Refusal[] = [];
  const values = stringsOf(config);
  for (const value of values) {
    if (REMOTE_URL.test(value)) refusals.push({ control: "C1", detail: `remote URL ${value}` });
  }
  const frontend = section(config, "build", "frontendDist");
  if (typeof frontend !== "string") {
    refusals.push({ control: "C1", detail: "build.frontendDist is not a folder path" });
  } else if (ABSOLUTE_URL.test(frontend) || frontend.startsWith("/")) {
    refusals.push({ control: "C1", detail: `build.frontendDist leaves the bundle: ${frontend}` });
  } else if (frontend.split("/").filter((part) => part === "..").length > 1) {
    // `../dist` is the app folder next to src-tauri; a second `..` leaves the app.
    refusals.push({ control: "C1", detail: `build.frontendDist leaves the app: ${frontend}` });
  }
  if (section(config, "build", "devUrl") !== undefined) {
    refusals.push({ control: "C1", detail: "build.devUrl is set in the release configuration" });
  }
  for (const window of windowsOf(config)) {
    if (window.url !== undefined) {
      refusals.push({ control: "C1", detail: `window ${String(window.label)} sets url` });
    }
  }
  if (section(config, "app", "security", "assetProtocol", "enable") === true) {
    refusals.push({ control: "C1", detail: "app.security.assetProtocol.enable is true" });
  }

  for (const { file, body } of capabilities) {
    if (isObject(body) && ("remote" in body || "remote_urls" in body)) {
      refusals.push({ control: "C2", detail: `${file} grants rights to a remote origin` });
    }
  }
  return {
    refusals,
    c1: values.length,
    c2: capabilities.length,
  };
}

/** C3: `default-src 'none'`, widened to the private scheme origin and nothing else. */
function checkCsp(config: JsonObject) {
  const refusals: Refusal[] = [];
  const csp = section(config, "app", "security", "csp");
  if (!isObject(csp)) {
    refusals.push({ control: "C3", detail: "app.security.csp is not an object of directives" });
    return { refusals, examined: 0 };
  }
  if (csp["default-src"] !== "'none'") {
    refusals.push({
      control: "C3",
      detail: `default-src is ${JSON.stringify(csp["default-src"])}`,
    });
  }
  const directives = Object.entries(csp);
  for (const [name, value] of directives) {
    if (!ALLOWED_DIRECTIVES.includes(name)) {
      refusals.push({ control: "C3", detail: `directive ${name} is not in the list` });
    }
    if (typeof value !== "string") {
      refusals.push({ control: "C3", detail: `directive ${name} is not a string` });
      continue;
    }
    const allowed = name === "connect-src" ? IPC_SOURCES : PRIVATE_SCHEME_SOURCES;
    for (const source of value.split(/\s+/).filter(Boolean)) {
      if (!allowed.includes(source)) {
        refusals.push({ control: "C3", detail: `${name} carries ${source}` });
      }
    }
  }
  if (section(config, "app", "security", "dangerousDisableAssetCspModification") !== undefined) {
    refusals.push({ control: "C3", detail: "dangerousDisableAssetCspModification is declared" });
  }
  return { refusals, examined: directives.length };
}

/** C4: every window is incognito (non-persistent WKWebsiteDataStore) and names no store. */
function checkStore(config: JsonObject) {
  const refusals: Refusal[] = [];
  const windows = windowsOf(config);
  for (const window of windows) {
    const label = String(window.label ?? "<no label>");
    if (window.incognito !== true) {
      refusals.push({ control: "C4", detail: `window ${label} is not incognito` });
    }
    for (const key of ["dataStoreIdentifier", "dataDirectory"]) {
      if (key in window) refusals.push({ control: "C4", detail: `window ${label} sets ${key}` });
    }
  }
  return { refusals, examined: windows.length };
}

/** C5: each right is `allow-<command>` by name; no wildcard, no default group, no inline capability. */
function checkCapabilities(config: JsonObject, capabilities: readonly Capability[]) {
  const refusals: Refusal[] = [];
  let examined = 0;
  for (const { file, body } of capabilities) {
    if (!isObject(body)) {
      refusals.push({ control: "C5", detail: `${file} is not an object` });
      continue;
    }
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    for (const permission of permissions) {
      examined += 1;
      if (typeof permission !== "string" || !ALLOW_PERMISSION.test(permission)) {
        refusals.push({
          control: "C5",
          detail: `${file} permission ${JSON.stringify(permission)}`,
        });
      }
    }
    for (const key of ["windows", "webviews"]) {
      const targets = body[key];
      if (Array.isArray(targets)) {
        for (const target of targets) {
          examined += 1;
          if (typeof target !== "string" || target.includes("*")) {
            refusals.push({
              control: "C5",
              detail: `${file} ${key} entry ${JSON.stringify(target)}`,
            });
          }
        }
      }
    }
  }
  const inline = section(config, "app", "security", "capabilities");
  if (Array.isArray(inline) && inline.some((entry) => typeof entry !== "string")) {
    refusals.push({
      control: "C5",
      detail: "app.security.capabilities carries an inline capability",
    });
  }
  if (section(config, "app", "withGlobalTauri") !== false) {
    refusals.push({ control: "C5", detail: "app.withGlobalTauri is not false" });
  }
  return { refusals, examined };
}

/** Commands the shell declares, read from the `COMMANDS` list that `build.rs` hands to tauri-build. */
export function declaredCommands(buildScript: string): string[] {
  const list = /const\s+COMMANDS\s*:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/.exec(buildScript);
  if (list === null || list[1] === undefined) return [];
  return [...list[1].matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1] ?? "");
}

/** Permissions of the capabilities that name a command: `allow-shell-ping` opens `shell_ping`. */
export function permissionCommands(capabilities: readonly Capability[]): string[] {
  return capabilities.flatMap(({ body }) =>
    isObject(body) && Array.isArray(body.permissions)
      ? body.permissions
          .filter((permission): permission is string => typeof permission === "string")
          .filter((permission) => ALLOW_PERMISSION.test(permission))
          .map((permission) => permission.slice("allow-".length).replaceAll("-", "_"))
      : [],
  );
}

export function checkShell(
  config: JsonObject,
  capabilities: readonly Capability[],
  commands: readonly string[],
): ControlReport {
  const remote = checkRemote(config, capabilities);
  const csp = checkCsp(config);
  const store = checkStore(config);
  const rights = checkCapabilities(config, capabilities);

  // A permission without a command, or a command without a permission, is drift.
  const refusals: Refusal[] = [
    ...remote.refusals,
    ...csp.refusals,
    ...store.refusals,
    ...rights.refusals,
  ];
  const permitted = permissionCommands(capabilities);
  for (const command of permitted) {
    if (!commands.includes(command)) {
      refusals.push({
        control: "C5",
        detail: `permission for ${command}, which build.rs does not declare`,
      });
    }
  }
  for (const command of commands) {
    if (!permitted.includes(command)) {
      refusals.push({
        control: "C5",
        detail: `command ${command} has no permission in capabilities/`,
      });
    }
  }
  return {
    examined: {
      C1: remote.c1,
      C2: remote.c2,
      C3: csp.examined,
      C4: store.examined,
      C5: rights.examined + commands.length,
    },
    refusals,
  };
}

export interface ShellFiles {
  readonly config: JsonObject;
  readonly capabilities: readonly Capability[];
  readonly commands: readonly string[];
}

/** Reads the shell configuration. A source that cannot be read throws: it is a failure, never an empty pass. */
export function readShellFiles(shellDirectory: string): ShellFiles {
  const config = JSON.parse(readFileSync(join(shellDirectory, "tauri.conf.json"), "utf8")) as Json;
  if (!isObject(config)) throw new Error("tauri.conf.json is not an object");
  const capabilities = readdirSync(join(shellDirectory, "capabilities"))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      body: JSON.parse(readFileSync(join(shellDirectory, "capabilities", file), "utf8")) as Json,
    }));
  const commands = declaredCommands(readFileSync(join(shellDirectory, "build.rs"), "utf8"));
  return { config, capabilities, commands };
}
