// SPDX-FileCopyrightText: 2026 Libre AI contributors
// SPDX-License-Identifier: EUPL-1.2

// PROTOCOL.md section 10.6 on fake accessibility trees: the element read, the
// three readings and their aggregation, and the classification of the codes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Interrupted, Unavailable } from "./attempts";
import {
  AX_ERROR,
  type AxOutcome,
  type AxSource,
  type AxValue,
  findNoteCopy,
  measureAccessibility,
  NOTE_COPY_NAME,
  threeReadings,
} from "./ax-read";

interface Node {
  name: string;
  attributes: Record<string, AxOutcome<AxValue<Node>>>;
  range?: (location: number, length: number) => AxOutcome<AxValue<Node>>;
}

const text = (value: string): AxOutcome<AxValue<Node>> => ({
  ok: true,
  value: { kind: "string", value },
});
const number = (value: number): AxOutcome<AxValue<Node>> => ({
  ok: true,
  value: { kind: "number", value },
});
const children = (value: Node[]): AxOutcome<AxValue<Node>> => ({
  ok: true,
  value: { kind: "elements", value },
});
const code = (value: number): AxOutcome<AxValue<Node>> => ({ ok: false, code: value });

function node(
  name: string,
  attributes: Record<string, AxOutcome<AxValue<Node>>> = {},
  range?: Node["range"],
): Node {
  return { name, attributes, range };
}

// The fake answers kAXErrorNoValue for any attribute a node does not carry.
function source(application: Node, exit: { code: number | null } = { code: null }) {
  const calls: string[] = [];
  const fake: AxSource<Node> = {
    application: () => application,
    attribute: (element, name) => {
      calls.push(`${element.name}.${name}`);
      return element.attributes[name] ?? code(AX_ERROR.noValue);
    },
    stringForRange: (element, location, length) => {
      calls.push(`${element.name}.AXStringForRange(${location},${length})`);
      return element.range?.(location, length) ?? code(AX_ERROR.parameterizedAttributeUnsupported);
    },
    shellExit: () => exit.code,
  };
  return { fake, calls };
}

const NOTE = "# large\n\nline two\n";

describe("the name of the copy is the one WP-8 gives it", () => {
  test("NOTE_COPY_NAME equals ACCESSIBLE_TEXT_LABEL of apps/desktop/src/editor/accessible-text.ts", () => {
    const file = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "apps",
      "desktop",
      "src",
      "editor",
      "accessible-text.ts",
    );
    const declared = /export const ACCESSIBLE_TEXT_LABEL = "([^"]+)";/.exec(
      readFileSync(file, "utf8"),
    )?.[1];
    expect(declared).toBe(NOTE_COPY_NAME);
  });
});

// PROTOCOL.md section 10.6: AXWindows, then AXChildren, depth first and in order; the
// first element whose AXDescription or AXTitle is the name of the copy.
describe("the element read", () => {
  test("depth first, in order: the copy is found under the second window after the whole first one", () => {
    const decoy = node("decoy", { AXDescription: text("Note text") });
    const deep = node("deep", { AXChildren: children([decoy]) });
    const first = node("w1", { AXChildren: children([deep]) });
    const copy = node("copy", { AXDescription: text(NOTE_COPY_NAME) });
    const later = node("later", { AXTitle: text(NOTE_COPY_NAME) });
    const second = node("w2", {
      AXChildren: children([node("x", { AXChildren: children([copy]) }), later]),
    });
    const app = node("app", { AXWindows: children([first, second]) });
    const found = findNoteCopy(source(app).fake);
    expect(found.element?.name).toBe("copy");
    // w1, deep, decoy, w2, x, copy
    expect(found.visited).toBe(6);
  });

  test("a name carried by AXTitle is found as well", () => {
    const copy = node("copy", { AXTitle: text(NOTE_COPY_NAME) });
    const app = node("app", { AXWindows: children([node("w", { AXChildren: children([copy]) })]) });
    expect(findNoteCopy(source(app).fake).element?.name).toBe("copy");
  });

  test("no element of that name: proportion 0, found false and the elements walked recorded apart", () => {
    const app = node("app", {
      AXWindows: children([node("w", { AXChildren: children([node("a"), node("b")]) })]),
      AXFocusedUIElement: {
        ok: true,
        value: { kind: "element", value: node("focus", { AXValue: text(NOTE) }) },
      },
    });
    const measure = measureAccessibility(source(app).fake, NOTE, 4);
    expect(measure).toMatchObject({
      found: false,
      visited: 3,
      matching: 0,
      chosen: null,
      total: NOTE.length,
    });
    // The focused element is read and recorded, without verdict.
    expect(measure.focused?.readings[1]).toEqual({
      reading: 2,
      length: NOTE.length,
      matching: NOTE.length,
    });
  });
});

describe("the three readings", () => {
  test("(1) is AXValue when it is as long as AXNumberOfCharacters", () => {
    const element = node("e", { AXNumberOfCharacters: number(NOTE.length), AXValue: text(NOTE) });
    expect(threeReadings(source(node("app")).fake, element, 4)).toEqual([NOTE, NOTE, ""]);
  });

  test("(1) is read by AXStringForRange in slices of ax-string-range-chars when AXValue is shorter", () => {
    const element = node(
      "e",
      { AXNumberOfCharacters: number(10), AXValue: text("abc") },
      // Ten letters, not digits: ten digits in a row read as a phone number to the personal-data gate.
      (location, length) => text("klmnopqrst".slice(location, location + length)),
    );
    const { fake, calls } = source(node("app"));
    expect(threeReadings(fake, element, 4)[0]).toBe("klmnopqrst");
    expect(calls.filter((call) => call.includes("AXStringForRange"))).toEqual([
      "e.AXStringForRange(0,4)",
      "e.AXStringForRange(4,4)",
      "e.AXStringForRange(8,2)",
    ]);
  });

  test("(3) concatenates the AXValue of the AXStaticText descendants in the order of the walk", () => {
    const leaf = (name: string, value: AxOutcome<AxValue<Node>> | null) =>
      node(
        name,
        value === null
          ? { AXRole: text("AXStaticText") }
          : { AXRole: text("AXStaticText"), AXValue: value },
      );
    const group = node("g", {
      AXRole: text("AXGroup"),
      AXChildren: children([leaf("s1", text("# large\n")), leaf("s2", null)]),
    });
    const element = node("e", { AXChildren: children([group, leaf("s3", text("\nline two\n"))]) });
    expect(threeReadings(source(node("app")).fake, element, 4)).toEqual(["", "", NOTE]);
  });

  // PROTOCOL.md section 10.6: the measure is the highest of the three proportions, so a
  // prefixed reading does not hide another that gives the note back.
  test("an AXValue prefixed by one unit gives 0 by (1) and (2); the measure comes from (3)", () => {
    // No two equal units side by side: shifted by one, no unit matches its position.
    const note = "# large\nline two\n";
    const prefixed = `x${note}`;
    const element = node("copy", {
      AXDescription: text(NOTE_COPY_NAME),
      AXRole: text("AXGroup"),
      AXSubrole: text("AXDocument"),
      AXNumberOfCharacters: number(prefixed.length),
      AXValue: text(prefixed),
      AXChildren: children([node("s", { AXRole: text("AXStaticText"), AXValue: text(note) })]),
    });
    const app = node("app", {
      AXWindows: children([node("w", { AXChildren: children([element]) })]),
    });
    const measure = measureAccessibility(source(app).fake, note, 4);
    expect(measure).toMatchObject({ found: true, matching: note.length, chosen: 3 });
    expect(measure.element).toEqual({
      role: "AXGroup",
      subrole: "AXDocument",
      readings: [
        { reading: 1, length: prefixed.length, matching: 0 },
        { reading: 2, length: prefixed.length, matching: 0 },
        { reading: 3, length: note.length, matching: note.length },
      ],
    });
  });

  test("at equal proportion the first reading in order gives the measure", () => {
    const element = node("copy", {
      AXDescription: text(NOTE_COPY_NAME),
      AXNumberOfCharacters: number(NOTE.length),
      AXValue: text(NOTE),
    });
    const app = node("app", { AXWindows: children([element]) });
    expect(measureAccessibility(source(app).fake, NOTE, 4)).toMatchObject({
      chosen: 1,
      matching: NOTE.length,
    });
  });
});

// PROTOCOL.md section 10.6: absent attribute, missing permission, instrument error;
// section 10.7: a shell that has exited is read before the code is classified.
describe("codes returned by a call", () => {
  const withValue = (outcome: AxOutcome<AxValue<Node>>) => node("e", { AXValue: outcome });

  for (const [name, absent] of [
    ["kAXErrorNoValue", AX_ERROR.noValue],
    ["kAXErrorAttributeUnsupported", AX_ERROR.attributeUnsupported],
    ["kAXErrorParameterizedAttributeUnsupported", AX_ERROR.parameterizedAttributeUnsupported],
    ["kAXErrorNotImplemented", AX_ERROR.notImplemented],
  ] as const) {
    test(`${name} is an absent attribute: the reading is the empty text`, () => {
      expect(threeReadings(source(node("app")).fake, withValue(code(absent)), 4)).toEqual([
        "",
        "",
        "",
      ]);
    });
  }

  test("kAXErrorAPIDisabled makes the measure unavailable, at any moment of the launch", () => {
    expect(() =>
      threeReadings(source(node("app")).fake, withValue(code(AX_ERROR.apiDisabled)), 4),
    ).toThrow(Unavailable);
    const app = node("app", { AXWindows: code(AX_ERROR.apiDisabled) });
    expect(() => findNoteCopy(source(app).fake)).toThrow(Unavailable);
  });

  test("any other code is an instrument error, with its code", () => {
    const run = () => threeReadings(source(node("app")).fake, withValue(code(-25204)), 4);
    expect(run).toThrow(Interrupted);
    expect(run).toThrow("-25204");
    try {
      run();
    } catch (error) {
      expect(error).toMatchObject({ cause: "instrument-error" });
    }
  });

  test("a shell that has exited wins over the code returned after its exit", () => {
    for (const returned of [-25204, AX_ERROR.apiDisabled, AX_ERROR.noValue]) {
      const { fake } = source(node("app"), { code: 1 });
      try {
        threeReadings(fake, withValue(code(returned)), 4);
        throw new Error("no interruption");
      } catch (error) {
        expect(error).toBeInstanceOf(Interrupted);
        expect(error).toMatchObject({ cause: "shell-exited" });
      }
    }
  });
});
