// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// Accessibility read of PROTOCOL.md section 10.6, through the macOS
// accessibility API called by bun:ffi (the shell forbids unsafe code, so the
// reader lives outside it). Every call is AXUIElementCopyAttributeValue or
// AXUIElementCopyParameterizedAttributeValue; frameworks are loaded only when
// a read is made.

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";

/** UTF-16 units equal at the same position, over the length of the reference (PROTOCOL.md section 8). */
export function exposedProportion(
  reference: string,
  exposed: string,
): { total: number; matching: number } {
  let matching = 0;
  for (let index = 0; index < reference.length; index += 1) {
    if (reference.charCodeAt(index) === exposed.charCodeAt(index)) matching += 1;
  }
  return { total: reference.length, matching };
}

const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
const K_CF_NUMBER_SINT64_TYPE = 4;
const K_AX_VALUE_CF_RANGE_TYPE = 4;
export const SLICE_UNITS = 10_000;

function openFrameworks() {
  const services = dlopen(
    "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices",
    {
      AXUIElementCreateApplication: { args: [FFIType.i32], returns: FFIType.ptr },
      AXUIElementCopyAttributeValue: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      AXUIElementCopyParameterizedAttributeValue: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      AXValueCreate: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
    },
  );
  const foundation = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.ptr,
    },
    CFStringGetLength: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFStringGetMaximumSizeForEncoding: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i64 },
    CFStringGetCString: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i64, FFIType.u32],
      returns: FFIType.bool,
    },
    CFGetTypeID: { args: [FFIType.ptr], returns: FFIType.u64 },
    CFStringGetTypeID: { args: [], returns: FFIType.u64 },
    CFNumberGetTypeID: { args: [], returns: FFIType.u64 },
    CFNumberGetValue: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.bool },
    CFRelease: { args: [FFIType.ptr], returns: FFIType.void },
  });
  return { ax: services.symbols, cf: foundation.symbols };
}

type Frameworks = ReturnType<typeof openFrameworks>;

function cfString(f: Frameworks, text: string): Pointer {
  const bytes = Buffer.from(`${text}\0`, "utf8");
  const created = f.cf.CFStringCreateWithCString(null, ptr(bytes), K_CF_STRING_ENCODING_UTF8);
  if (created === null) throw new Error(`ax: cannot create the CFString ${text}`);
  return created;
}

function jsString(f: Frameworks, value: Pointer): string {
  if (f.cf.CFGetTypeID(value) !== f.cf.CFStringGetTypeID())
    throw new Error("ax: the value is not a string");
  const length = Number(f.cf.CFStringGetLength(value));
  const size =
    Number(f.cf.CFStringGetMaximumSizeForEncoding(length, K_CF_STRING_ENCODING_UTF8)) + 1;
  const buffer = Buffer.alloc(size);
  if (!f.cf.CFStringGetCString(value, ptr(buffer), size, K_CF_STRING_ENCODING_UTF8)) {
    throw new Error("ax: the string has no UTF-8 form (lone surrogate)");
  }
  const text = buffer.subarray(0, buffer.indexOf(0)).toString("utf8");
  // A NUL inside the text would cut the C string: the lengths would differ.
  if (text.length !== length) throw new Error("ax: the string was not read whole");
  return text;
}

function copy(f: Frameworks, element: Pointer, attribute: string, parameter?: Pointer): Pointer {
  const name = cfString(f, attribute);
  const out = new BigUint64Array(1);
  try {
    const status =
      parameter === undefined
        ? f.ax.AXUIElementCopyAttributeValue(element, name, ptr(out))
        : f.ax.AXUIElementCopyParameterizedAttributeValue(element, name, parameter, ptr(out));
    if (status !== 0) throw new Error(`ax: ${attribute} failed with AXError ${status}`);
  } finally {
    f.cf.CFRelease(name);
  }
  const value = Number(out[0]);
  if (value === 0) throw new Error(`ax: ${attribute} returned no value`);
  return value as Pointer;
}

function integer(f: Frameworks, value: Pointer): number {
  if (f.cf.CFGetTypeID(value) !== f.cf.CFNumberGetTypeID())
    throw new Error("ax: the value is not a number");
  const out = new BigInt64Array(1);
  if (!f.cf.CFNumberGetValue(value, K_CF_NUMBER_SINT64_TYPE, ptr(out)))
    throw new Error("ax: number unreadable");
  return Number(out[0]);
}

export interface AccessibilityRead {
  role: string;
  numberOfCharacters: number;
  text: string;
  /** "AXValue", or "AXStringForRange" when AXValue was absent or shorter than AXNumberOfCharacters. */
  source: "AXValue" | "AXStringForRange";
}

/** Reads the focused element of the application `pid`. The caller has checked `accessibilityTrusted()`. */
export function readFocusedText(pid: number): AccessibilityRead {
  const f = openFrameworks();
  const application = f.ax.AXUIElementCreateApplication(pid);
  if (application === null) throw new Error("ax: AXUIElementCreateApplication returned NULL");
  const owned: Pointer[] = [application];
  const keep = (value: Pointer): Pointer => {
    owned.push(value);
    return value;
  };
  try {
    const focused = keep(copy(f, application, "AXFocusedUIElement"));
    const role = jsString(f, keep(copy(f, focused, "AXRole")));
    const numberOfCharacters = integer(f, keep(copy(f, focused, "AXNumberOfCharacters")));
    let value: string | null = null;
    try {
      value = jsString(f, keep(copy(f, focused, "AXValue")));
    } catch {
      value = null;
    }
    if (value !== null && value.length >= numberOfCharacters) {
      return { role, numberOfCharacters, text: value, source: "AXValue" };
    }
    const slices: string[] = [];
    for (let location = 0; location < numberOfCharacters; location += SLICE_UNITS) {
      const range = new BigInt64Array([
        BigInt(location),
        BigInt(Math.min(SLICE_UNITS, numberOfCharacters - location)),
      ]);
      const parameter = f.ax.AXValueCreate(K_AX_VALUE_CF_RANGE_TYPE, ptr(range));
      if (parameter === null) throw new Error("ax: AXValueCreate returned NULL");
      keep(parameter);
      slices.push(jsString(f, keep(copy(f, focused, "AXStringForRange", parameter))));
    }
    return { role, numberOfCharacters, text: slices.join(""), source: "AXStringForRange" };
  } finally {
    for (const value of owned) f.cf.CFRelease(value);
  }
}
