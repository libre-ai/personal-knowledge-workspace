// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Rejection reads of PROTOCOL.md section 10.7 and the frontmost-application
// check that precedes every system keystroke. CoreGraphics is loaded only when
// a read is made, so importing this module on Linux (the CI of the static
// tests) loads nothing.

import { dlopen, FFIType } from "bun:ffi";

function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${argv[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/**
 * `ioreg -n Root -d1 -a`: the entry of `IOConsoleUsers` whose
 * `kCGSSessionUserIDKey` is `uid` is locked when it carries
 * `CGSSessionScreenIsLocked` true. No entry for `uid` is an error: an
 * unreadable state is never an unlocked one.
 */
export function parseSessionLocked(plist: string, uid: number): boolean {
  const start = plist.indexOf("<key>IOConsoleUsers</key>");
  if (start === -1) throw new Error("ioreg: no IOConsoleUsers");
  const end = plist.indexOf("</array>", start);
  if (end === -1) throw new Error("ioreg: IOConsoleUsers is not closed");
  const users = plist.slice(start, end).match(/<dict>[\s\S]*?<\/dict>/g) ?? [];
  const mine = users.filter((entry) =>
    new RegExp(`<key>kCGSSessionUserIDKey</key>\\s*<integer>${uid}</integer>`).test(entry),
  );
  if (mine.length === 0) throw new Error(`ioreg: no console session for uid ${uid}`);
  return mine.some((entry) => /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(entry));
}

export function sessionLocked(): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("no uid on this platform");
  return parseSessionLocked(run(["ioreg", "-n", "Root", "-d1", "-a"]), uid);
}

let coreGraphics: ReturnType<typeof openCoreGraphics> | null = null;
function openCoreGraphics() {
  return dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
    CGMainDisplayID: { args: [], returns: FFIType.u32 },
    CGDisplayIsAsleep: { args: [FFIType.u32], returns: FFIType.u32 },
  });
}

/** `CGDisplayIsAsleep(CGMainDisplayID())` is non-zero: the screen is off. */
export function displayAsleep(): boolean {
  coreGraphics ??= openCoreGraphics();
  return coreGraphics.symbols.CGDisplayIsAsleep(coreGraphics.symbols.CGMainDisplayID()) !== 0;
}

export type Rejection = "session-locked" | "display-asleep";

/** The cause that rejects a launch now, or null. */
export function rejection(): Rejection | null {
  if (sessionLocked()) return "session-locked";
  if (displayAsleep()) return "display-asleep";
  return null;
}

/**
 * PROTOCOL.md section 10.7: the frontmost application is read as
 * `NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier`. A new
 * `osascript` process reads it each time: a process that does not spin a run
 * loop keeps a stale value of this property, which macOS updates by notification.
 * shortcut: one process per keystroke (40 to 90 ms, measured 2026-10-24);
 * upgrade trigger: a series whose AT-01 edit launches are too slow to complete.
 */
export const FRONTMOST_COMMAND = [
  "osascript",
  "-l",
  "JavaScript",
  "-e",
  'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier',
] as const;

export function parseFrontmostPid(text: string): number {
  const pid = /^\s*([0-9]+)\s*$/.exec(text)?.[1];
  if (pid === undefined)
    throw new Error(`NSWorkspace: no frontmost application pid in ${JSON.stringify(text)}`);
  return Number(pid);
}

/** The pid of the frontmost application: system keystrokes go there. */
export function frontmostPid(): number {
  return parseFrontmostPid(run([...FRONTMOST_COMMAND]));
}
