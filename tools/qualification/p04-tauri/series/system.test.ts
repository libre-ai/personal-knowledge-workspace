// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Fixtures written from the output shapes of `ioreg -n Root -d1 -a`,
// `lsappinfo front`, `lsappinfo info -only pid ...` and `ps -A -o pid=,rss=,comm=`
// on macOS 26, with synthetic values (no session identifier of a real machine).

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { exposedProportion } from "./ax";
import { KEY_CODES, keyCodeOf } from "./keys";
import { attributeHelpers, HELPER_NAMES, parseProcessTable, rssMib } from "./memory";
import { readProtocol, seriesParameters } from "./protocol";
import { parseFrontAsn, parseFrontPid, parseSessionLocked } from "./system";

function consoleUsers(...entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>IOConsoleUsers</key>
	<array>
${entries.join("\n")}
	</array>
	<key>IOKitBuildVersion</key>
	<string>fixture</string>
</dict>
</plist>`;
}

function user(uid: number, locked: boolean | null): string {
  const lock =
    locked === null ? "" : `\t\t\t<key>CGSSessionScreenIsLocked</key>\n\t\t\t<${locked}/>\n`;
  return `\t\t<dict>\n${lock}\t\t\t<key>kCGSSessionOnConsoleKey</key>\n\t\t\t<true/>\n\t\t\t<key>kCGSSessionUserIDKey</key>\n\t\t\t<integer>${uid}</integer>\n\t\t</dict>`;
}

describe("session lock (PROTOCOL.md section 10.7)", () => {
  test("no lock key: the session is not locked", () => {
    expect(parseSessionLocked(consoleUsers(user(501, null)), 501)).toBe(false);
  });

  test("CGSSessionScreenIsLocked true: locked", () => {
    expect(parseSessionLocked(consoleUsers(user(501, true)), 501)).toBe(true);
  });

  test("the lock of another user's session is not ours", () => {
    expect(parseSessionLocked(consoleUsers(user(502, true), user(501, false)), 501)).toBe(false);
  });

  test("no console session for the user is an error, not an unlocked session", () => {
    expect(() => parseSessionLocked(consoleUsers(user(502, false)), 501)).toThrow();
    expect(() => parseSessionLocked("<plist/>", 501)).toThrow();
  });
});

describe("frontmost application", () => {
  test("the ASN of lsappinfo front and the pid of lsappinfo info", () => {
    expect(parseFrontAsn("ASN:0x0-0x1a01a:\n")).toBe("ASN:0x0-0x1a01a:");
    expect(parseFrontPid('"pid"=4242\n')).toBe(4242);
    expect(() => parseFrontAsn("\n")).toThrow();
    expect(() => parseFrontPid("[ NULL ]\n")).toThrow();
  });
});

const WEBKIT = "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices";
const table = (rows: [number, number, string][]) =>
  rows
    .map(([pid, rss, comm]) => `${String(pid).padStart(6)} ${String(rss).padStart(8)} ${comm}`)
    .join("\n");

describe("NFR-10 processes (PROTOCOL.md section 10.4)", () => {
  const before = parseProcessTable(
    table([
      [1, 100, "/sbin/launchd"],
      [
        300,
        50000,
        `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent`,
      ],
    ]),
  );
  const after = parseProcessTable(
    table([
      [1, 100, "/sbin/launchd"],
      [
        300,
        50000,
        `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent`,
      ],
      [900, 102400, "/tmp/target/release/examples/p04_series"],
      [
        901,
        204800,
        `${WEBKIT}/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent`,
      ],
      [902, 51200, `${WEBKIT}/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU`],
      [
        903,
        10240,
        `${WEBKIT}/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking`,
      ],
    ]),
  );

  test("the three helper names", () => {
    expect([...HELPER_NAMES]).toEqual([
      "com.apple.WebKit.WebContent",
      "com.apple.WebKit.GPU",
      "com.apple.WebKit.Networking",
    ]);
  });

  test("helpers born after the launch are attributed by difference, the older one is not", () => {
    expect(attributeHelpers(before, after)).toEqual({ ok: true, pids: [901, 902, 903] });
  });

  test("two new WebContent processes cannot be attributed: the launch is redone", () => {
    const crowded = new Map(after);
    crowded.set(904, { rssKib: 1, name: "com.apple.WebKit.WebContent" });
    expect(attributeHelpers(before, crowded)).toMatchObject({ ok: false });
  });

  test("a helper missing cannot be attributed either", () => {
    const missing = new Map(after);
    missing.delete(902);
    expect(attributeHelpers(before, missing)).toMatchObject({ ok: false });
  });

  test("the reading is the sum of the RSS of the counted processes, in Mio", () => {
    // (102400 + 204800 + 51200 + 10240) KiB = 368640 KiB = 360 Mio
    expect(rssMib(after, [900, 901, 902, 903])).toBe(360);
  });

  test("a counted process absent from the table is an error, not a zero", () => {
    expect(() => rssMib(after, [900, 999])).toThrow("999");
  });
});

describe("accessibility proportion (PROTOCOL.md sections 8 and 10.6)", () => {
  test("equal UTF-16 units at the same position, over the reference length", () => {
    expect(exposedProportion("abcd", "abcd")).toEqual({ total: 4, matching: 4 });
    expect(exposedProportion("abcd", "abXd")).toEqual({ total: 4, matching: 3 });
    expect(exposedProportion("abcd", "ab")).toEqual({ total: 4, matching: 2 });
    expect(exposedProportion("ab", "abcd")).toEqual({ total: 2, matching: 2 });
  });

  test("a non-BMP character is two units", () => {
    expect(exposedProportion("a\u{1f600}", "a\u{1f600}")).toEqual({ total: 3, matching: 3 });
    expect(exposedProportion("a\u{1f600}", "a\u{1f601}")).toEqual({ total: 3, matching: 2 });
  });

  test("a shifted text matches only before the shift", () => {
    expect(exposedProportion("abcd", "xabcd")).toEqual({ total: 4, matching: 0 });
  });
});

describe("keystrokes", () => {
  const parameters = seriesParameters(readProtocol(join(import.meta.dir, "..", "..", "..", "..")));

  test("every character the series types has a virtual key code", () => {
    for (const character of `${parameters.at02TypedCycle}${parameters.at01EditText}`) {
      expect(keyCodeOf(character)).toBeGreaterThanOrEqual(0);
    }
  });

  test("a character outside the table is refused", () => {
    expect(() => keyCodeOf("A")).toThrow();
    expect(() => keyCodeOf(" ")).toThrow();
  });

  test("key codes are distinct", () => {
    const codes = Object.values(KEY_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
