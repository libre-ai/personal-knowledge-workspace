// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// The accessibility measure of PROTOCOL.md section 10.6, apart from the macOS
// calls: which element is read, the three readings of its text and their
// aggregation, and how a code returned by a call is classified. The calls come
// from an `AxSource` (`ax.ts` over bun:ffi; fakes in `ax-read.test.ts`), so the
// procedure is tested without the Accessibility permission.

import { Interrupted, Unavailable } from "./attempts";
import { shellExited } from "./shell";

/**
 * The name of the copy of the note that WP-8 exposes (`ACCESSIBLE_TEXT_LABEL`,
 * `apps/desktop/src/editor/accessible-text.ts`; `ax-read.test.ts` checks they agree).
 */
export const NOTE_COPY_NAME = "Note text, whole note, read only";

/** `HIServices/AXError.h`. */
export const AX_ERROR = {
  success: 0,
  attributeUnsupported: -25205,
  notImplemented: -25208,
  apiDisabled: -25211,
  noValue: -25212,
  parameterizedAttributeUnsupported: -25213,
} as const;

/** The codes PROTOCOL.md section 10.6 reads as an absent attribute: properties of the product measured. */
export const ABSENT_CODES: readonly number[] = [
  AX_ERROR.noValue,
  AX_ERROR.attributeUnsupported,
  AX_ERROR.parameterizedAttributeUnsupported,
  AX_ERROR.notImplemented,
];

export type AxValue<E> =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "element"; value: E }
  | { kind: "elements"; value: E[] }
  | { kind: "other" };

/** One call: its value, or the AXError code it returned. */
export type AxOutcome<T> = { ok: true; value: T } | { ok: false; code: number };

export interface AxSource<E> {
  application(): E;
  attribute(element: E, name: string): AxOutcome<AxValue<E>>;
  /** `AXStringForRange` over `[location, location + length)`, in UTF-16 units. */
  stringForRange(element: E, location: number, length: number): AxOutcome<AxValue<E>>;
  /** The exit code of the shell once it has exited, else null: read before a code is classified. */
  shellExit(): number | null;
}

/**
 * The value of a call, or null when the attribute is absent. `kAXErrorAPIDisabled`,
 * at any moment of the launch, makes the measure unavailable; any other code is
 * an instrument error, unless the shell has exited, which is read first
 * (PROTOCOL.md sections 10.6 and 10.7).
 */
function answerOf<E>(
  source: AxSource<E>,
  outcome: AxOutcome<AxValue<E>>,
  what: string,
): AxValue<E> | null {
  if (outcome.ok) return outcome.value;
  const exit = source.shellExit();
  if (exit !== null) throw shellExited(exit);
  if (ABSENT_CODES.includes(outcome.code)) return null;
  if (outcome.code === AX_ERROR.apiDisabled) {
    throw new Unavailable(
      `ax: kAXErrorAPIDisabled on ${what}: the Accessibility permission is missing`,
    );
  }
  throw new Interrupted("instrument-error", `ax: ${what} returned AXError ${outcome.code}`);
}

function stringAttribute<E>(source: AxSource<E>, element: E, name: string): string | null {
  const value = answerOf(source, source.attribute(element, name), name);
  return value?.kind === "string" ? value.value : null;
}

function elementsAttribute<E>(source: AxSource<E>, element: E, name: string): E[] {
  const value = answerOf(source, source.attribute(element, name), name);
  return value?.kind === "elements" ? value.value : [];
}

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

/**
 * The element read: from the application, `AXWindows` then `AXChildren`, depth
 * first and in order, the first whose `AXDescription` or `AXTitle` is the name
 * of the copy. `visited` counts the elements examined.
 */
export function findNoteCopy<E>(source: AxSource<E>): { element: E | null; visited: number } {
  let visited = 0;
  const visit = (element: E): E | null => {
    visited += 1;
    if (
      stringAttribute(source, element, "AXDescription") === NOTE_COPY_NAME ||
      stringAttribute(source, element, "AXTitle") === NOTE_COPY_NAME
    ) {
      return element;
    }
    for (const child of elementsAttribute(source, element, "AXChildren")) {
      const found = visit(child);
      if (found !== null) return found;
    }
    return null;
  };
  for (const window of elementsAttribute(source, source.application(), "AXWindows")) {
    const found = visit(window);
    if (found !== null) return { element: found, visited };
  }
  return { element: null, visited };
}

/** The three readings of section 10.6, in their order; one that does not apply is the empty text. */
export function threeReadings<E>(
  source: AxSource<E>,
  element: E,
  sliceChars: number,
): [string, string, string] {
  // (1) under AXNumberOfCharacters: AXValue, or AXStringForRange when AXValue is absent or shorter.
  let first = "";
  const count = answerOf(
    source,
    source.attribute(element, "AXNumberOfCharacters"),
    "AXNumberOfCharacters",
  );
  const value = stringAttribute(source, element, "AXValue");
  if (count?.kind === "number") {
    if (value !== null && value.length >= count.value) first = value;
    else {
      const slices: string[] = [];
      let applies = true;
      for (let location = 0; location < count.value && applies; location += sliceChars) {
        const length = Math.min(sliceChars, count.value - location);
        const slice = answerOf(
          source,
          source.stringForRange(element, location, length),
          "AXStringForRange",
        );
        if (slice?.kind === "string") slices.push(slice.value);
        else applies = false;
      }
      first = applies ? slices.join("") : "";
    }
  }
  // (2) AXValue of the element when it is a string.
  const second = value ?? "";
  // (3) the AXValue of its AXStaticText descendants, in the order of the same walk.
  const texts: string[] = [];
  const walk = (parent: E): void => {
    for (const child of elementsAttribute(source, parent, "AXChildren")) {
      if (stringAttribute(source, child, "AXRole") === "AXStaticText") {
        texts.push(stringAttribute(source, child, "AXValue") ?? "");
      }
      walk(child);
    }
  };
  walk(element);
  return [first, second, texts.join("")];
}

export interface ReadingRecord {
  /** 1, 2 or 3: the order of section 10.6. */
  reading: 1 | 2 | 3;
  /** UTF-16 units read. */
  length: number;
  matching: number;
}

export interface ElementRecord {
  role: string | null;
  subrole: string | null;
  readings: ReadingRecord[];
}

export interface AccessibilityMeasure {
  found: boolean;
  visited: number;
  total: number;
  /** The highest of the three proportions' matching units; 0 when the copy is not found. */
  matching: number;
  /** The reading that gives the measure, the first in the order (1), (2), (3) at equal proportion; null when not found. */
  chosen: 1 | 2 | 3 | null;
  element: ElementRecord | null;
  /** `AXFocusedUIElement`, read by the same attributes, recorded without verdict. */
  focused: ElementRecord | null;
}

function record<E>(
  source: AxSource<E>,
  element: E,
  reference: string,
  sliceChars: number,
): ElementRecord {
  const readings = threeReadings(source, element, sliceChars).map((text, index) => ({
    reading: (index + 1) as 1 | 2 | 3,
    length: text.length,
    matching: exposedProportion(reference, text).matching,
  }));
  return {
    role: stringAttribute(source, element, "AXRole"),
    subrole: stringAttribute(source, element, "AXSubrole"),
    readings,
  };
}

/** The best reading: the highest matching, the first in order at equality. */
export function chosenReading(readings: readonly ReadingRecord[]): ReadingRecord | null {
  let best: ReadingRecord | null = null;
  for (const reading of readings)
    if (best === null || reading.matching > best.matching) best = reading;
  return best;
}

export function measureAccessibility<E>(
  source: AxSource<E>,
  reference: string,
  sliceChars: number,
): AccessibilityMeasure {
  const { element, visited } = findNoteCopy(source);
  const focusedValue = answerOf(
    source,
    source.attribute(source.application(), "AXFocusedUIElement"),
    "AXFocusedUIElement",
  );
  const focused =
    focusedValue?.kind === "element"
      ? record(source, focusedValue.value, reference, sliceChars)
      : null;
  if (element === null) {
    return {
      found: false,
      visited,
      total: reference.length,
      matching: 0,
      chosen: null,
      element: null,
      focused,
    };
  }
  const read = record(source, element, reference, sliceChars);
  const best = chosenReading(read.readings);
  return {
    found: true,
    visited,
    total: reference.length,
    matching: best?.matching ?? 0,
    chosen: best?.reading ?? null,
    element: read,
    focused,
  };
}
