// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// System keystrokes of AT-01 and AT-02 (PROTOCOL.md section 10.2): keyDown then
// keyUp of one key without modifier, made by CGEventCreateKeyboardEvent and
// posted by CGEventPost at kCGHIDEventTap. macOS delivers posted events only to
// a process trusted for Accessibility; untrusted, they are dropped without an
// error, so the series checks `accessibilityTrusted()` first and declares the
// measures unavailable rather than typing into nothing.
//
// The key code is the ANSI position of the character; the character itself is
// set on the event (CGEventKeyboardSetUnicodeString), so the text does not
// depend on the keyboard layout of the machine (AZERTY puts "a" on another key).

import { dlopen, FFIType, ptr } from "bun:ffi";

/** kVK_ANSI_* of HIToolbox Events.h for the characters the series types. */
export const KEY_CODES: Readonly<Record<string, number>> = {
  a: 0x00,
  s: 0x01,
  d: 0x02,
  f: 0x03,
  h: 0x04,
  g: 0x05,
  z: 0x06,
  x: 0x07,
  c: 0x08,
  v: 0x09,
  b: 0x0b,
  q: 0x0c,
  w: 0x0d,
  e: 0x0e,
  r: 0x0f,
  y: 0x10,
  t: 0x11,
  "1": 0x12,
  "2": 0x13,
  "3": 0x14,
  "4": 0x15,
  "6": 0x16,
  "5": 0x17,
  "9": 0x19,
  "7": 0x1a,
  "8": 0x1c,
  "0": 0x1d,
  o: 0x1f,
  u: 0x20,
  i: 0x22,
  p: 0x23,
  l: 0x25,
  j: 0x26,
  k: 0x28,
  n: 0x2d,
  m: 0x2e,
};

export function keyCodeOf(character: string): number {
  const code = KEY_CODES[character];
  if (code === undefined) throw new Error(`keys: no key code for ${JSON.stringify(character)}`);
  return code;
}

const K_CG_HID_EVENT_TAP = 0;

function openFrameworks() {
  const graphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
    CGEventCreateKeyboardEvent: {
      args: [FFIType.ptr, FFIType.u16, FFIType.bool],
      returns: FFIType.ptr,
    },
    CGEventKeyboardSetUnicodeString: {
      args: [FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.void,
    },
    CGEventPost: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.void },
  });
  const foundation = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  });
  const services = dlopen(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    {
      AXIsProcessTrusted: { args: [], returns: FFIType.bool },
    },
  );
  return { graphics: graphics.symbols, foundation: foundation.symbols, services: services.symbols };
}

let frameworks: ReturnType<typeof openFrameworks> | null = null;
function loaded() {
  frameworks ??= openFrameworks();
  return frameworks;
}

/** `AXIsProcessTrusted()` of this process: the permission both keystrokes and accessibility reads need. */
export function accessibilityTrusted(): boolean {
  if (process.platform !== "darwin") return false;
  return loaded().services.AXIsProcessTrusted();
}

/** Posts keyDown then keyUp of `character`. The caller has checked the frontmost process. */
export function postCharacter(character: string): void {
  const { graphics, foundation } = loaded();
  const code = keyCodeOf(character);
  const units = new Uint16Array([...character].map((unit) => unit.charCodeAt(0)));
  for (const down of [true, false]) {
    const event = graphics.CGEventCreateKeyboardEvent(null, code, down);
    if (event === null) throw new Error("keys: CGEventCreateKeyboardEvent returned NULL");
    graphics.CGEventKeyboardSetUnicodeString(event, units.length, ptr(units));
    graphics.CGEventPost(K_CG_HID_EVENT_TAP, event);
    foundation.CFRelease(event);
  }
}
