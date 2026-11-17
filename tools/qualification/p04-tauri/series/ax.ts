// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The macOS accessibility calls of PROTOCOL.md section 10.6, by bun:ffi (the
// shell forbids unsafe code, so the reader lives outside it), as an `AxSource`
// for `ax-read.ts`, which holds the procedure. Every call is
// AXUIElementCopyAttributeValue or AXUIElementCopyParameterizedAttributeValue;
// frameworks are loaded only when a read is made. Nothing here is run by the
// tests: without the Accessibility permission the calls read nothing.

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";

import type { AxOutcome, AxSource, AxValue } from "./ax-read";

const K_CF_STRING_ENCODING_UTF8 = 0x08000100;
const K_CF_NUMBER_SINT64_TYPE = 4;
const K_AX_VALUE_CF_RANGE_TYPE = 4;

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
      AXUIElementGetTypeID: { args: [], returns: FFIType.u64 },
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
    CFArrayGetTypeID: { args: [], returns: FFIType.u64 },
    CFArrayGetCount: { args: [FFIType.ptr], returns: FFIType.i64 },
    CFArrayGetValueAtIndex: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.ptr },
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

/** The accessibility tree of the process `pid`. The caller has checked `accessibilityTrusted()`. */
export function ffiSource(
  pid: number,
  shellExit: () => number | null,
): AxSource<Pointer> & { dispose(): void } {
  const f = openFrameworks();
  const application = f.ax.AXUIElementCreateApplication(pid);
  if (application === null) throw new Error("ax: AXUIElementCreateApplication returned NULL");
  // Every value copied stays alive until dispose: elements of an array belong to it.
  const owned: Pointer[] = [application];
  const types = {
    string: f.cf.CFStringGetTypeID(),
    number: f.cf.CFNumberGetTypeID(),
    array: f.cf.CFArrayGetTypeID(),
    element: f.ax.AXUIElementGetTypeID(),
  };
  const fromCF = (value: Pointer): AxValue<Pointer> => {
    const type = f.cf.CFGetTypeID(value);
    if (type === types.string) return { kind: "string", value: jsString(f, value) };
    if (type === types.number) {
      const out = new BigInt64Array(1);
      if (!f.cf.CFNumberGetValue(value, K_CF_NUMBER_SINT64_TYPE, ptr(out)))
        throw new Error("ax: number unreadable");
      return { kind: "number", value: Number(out[0]) };
    }
    if (type === types.element) return { kind: "element", value };
    if (type === types.array) {
      const elements: Pointer[] = [];
      const count = Number(f.cf.CFArrayGetCount(value));
      for (let index = 0; index < count; index += 1) {
        const item = f.cf.CFArrayGetValueAtIndex(value, index);
        if (item !== null && f.cf.CFGetTypeID(item) === types.element) elements.push(item);
      }
      return { kind: "elements", value: elements };
    }
    return { kind: "other" };
  };
  const call = (
    element: Pointer,
    attribute: string,
    parameter: Pointer | null,
  ): AxOutcome<AxValue<Pointer>> => {
    const name = cfString(f, attribute);
    const out = new BigUint64Array(1);
    let status: number;
    try {
      status =
        parameter === null
          ? f.ax.AXUIElementCopyAttributeValue(element, name, ptr(out))
          : f.ax.AXUIElementCopyParameterizedAttributeValue(element, name, parameter, ptr(out));
    } finally {
      f.cf.CFRelease(name);
    }
    if (status !== 0) return { ok: false, code: status };
    const value = Number(out[0]);
    if (value === 0) return { ok: true, value: { kind: "other" } };
    owned.push(value as Pointer);
    return { ok: true, value: fromCF(value as Pointer) };
  };
  return {
    application: () => application,
    attribute: (element, name) => call(element, name, null),
    stringForRange: (element, location, length) => {
      const range = new BigInt64Array([BigInt(location), BigInt(length)]);
      const parameter = f.ax.AXValueCreate(K_AX_VALUE_CF_RANGE_TYPE, ptr(range));
      if (parameter === null) throw new Error("ax: AXValueCreate returned NULL");
      owned.push(parameter);
      return call(element, "AXStringForRange", parameter);
    },
    shellExit,
    dispose: () => {
      for (const value of owned) f.cf.CFRelease(value);
      owned.length = 0;
    },
  };
}
