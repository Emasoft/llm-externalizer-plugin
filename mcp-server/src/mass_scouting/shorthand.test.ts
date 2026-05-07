/**
 * Unit tests for the `--field 'NAME:TYPE=DESCRIPTION'` shorthand parser.
 *
 * Covers every supported form documented in shorthand.ts:
 *   • bool, string, string(N), enum(a,b,c)
 *   • array, array(N), array_enum(a,b), array_enum(a,b)(N)
 *   • int, int(min-max), int(min-), int(-max)
 *   • number, number(min-max)
 *
 * Plus the failure shapes:
 *   • missing "=" / ":" separators
 *   • bad name regex
 *   • bool with args
 *   • int range with non-integer bound
 *   • inverted range (min > max)
 *   • unbalanced parentheses
 *   • empty enum
 */

import { describe, it, expect } from "vitest";
import { parseShorthand, parseShorthands, ShorthandParseError } from "./shorthand";

// ── happy paths ────────────────────────────────────────────────────────

describe("parseShorthand — happy", () => {
  it("parses bool", () => {
    /** Smallest possible form: name + type + description. */
    expect(parseShorthand("is_async:bool=true if file uses async")).toEqual({
      name: "is_async",
      type: { kind: "bool" },
      description: "true if file uses async",
    });
  });

  it("parses string with no constraints", () => {
    /** Bare string accepts any non-empty value at scout time. */
    expect(parseShorthand("title:string=the title")).toEqual({
      name: "title",
      type: { kind: "string" },
      description: "the title",
    });
  });

  it("parses string(N) with max_length", () => {
    /** Bound the size of a free-form field. */
    expect(parseShorthand("title:string(120)=the title")).toEqual({
      name: "title",
      type: { kind: "string", max_length: 120 },
      description: "the title",
    });
  });

  it("parses enum with values", () => {
    /** Categorical extraction. */
    expect(parseShorthand("severity:enum(info,warn,error)=severity level")).toEqual({
      name: "severity",
      type: { kind: "enum", values: ["info", "warn", "error"] },
      description: "severity level",
    });
  });

  it("parses array shorthand and array(N)", () => {
    /** "array" is a shorthand alias for "array_string". */
    expect(parseShorthand("tags:array=any tags")).toEqual({
      name: "tags",
      type: { kind: "array_string" },
      description: "any tags",
    });
    expect(parseShorthand("tags:array(3)=at most three")).toEqual({
      name: "tags",
      type: { kind: "array_string", max_items: 3 },
      description: "at most three",
    });
  });

  it("parses array_enum with and without max_items", () => {
    /** Two arg-blocks: (values)(max). */
    expect(
      parseShorthand("kinds:array_enum(api,ui,data)=categorical tags"),
    ).toEqual({
      name: "kinds",
      type: { kind: "array_enum", values: ["api", "ui", "data"] },
      description: "categorical tags",
    });
    expect(
      parseShorthand("kinds:array_enum(api,ui,data)(2)=at most two"),
    ).toEqual({
      name: "kinds",
      type: { kind: "array_enum", values: ["api", "ui", "data"], max_items: 2 },
      description: "at most two",
    });
  });

  it("parses int with no range", () => {
    /** Unconstrained integer. */
    expect(parseShorthand("count:int=just a count")).toEqual({
      name: "count",
      type: { kind: "int" },
      description: "just a count",
    });
  });

  it("parses int with full range", () => {
    /** Both ends present. */
    expect(parseShorthand("score:int(1-10)=1..10 score")).toEqual({
      name: "score",
      type: { kind: "int", min: 1, max: 10 },
      description: "1..10 score",
    });
  });

  it("parses int with open upper bound", () => {
    /** "min-" → only min, max is unbounded. */
    expect(parseShorthand("score:int(0-)=non-negative")).toEqual({
      name: "score",
      type: { kind: "int", min: 0 },
      description: "non-negative",
    });
  });

  it("parses int with open lower bound", () => {
    /** "-max" → only max, min is unbounded. */
    expect(parseShorthand("score:int(-100)=cap at 100")).toEqual({
      name: "score",
      type: { kind: "int", max: 100 },
      description: "cap at 100",
    });
  });

  it("parses number with float range", () => {
    /** Probabilities, ratios, etc. */
    expect(parseShorthand("conf:number(0.0-1.0)=confidence")).toEqual({
      name: "conf",
      type: { kind: "number", min: 0, max: 1 },
      description: "confidence",
    });
  });

  it("preserves an `=` inside the description", () => {
    /** Only the FIRST "=" splits head from description. */
    expect(
      parseShorthand("flag:bool=true if expression uses x=1 pattern"),
    ).toEqual({
      name: "flag",
      type: { kind: "bool" },
      description: "true if expression uses x=1 pattern",
    });
  });
});

// ── failure paths ──────────────────────────────────────────────────────

describe("parseShorthand — failure", () => {
  it("rejects missing '='", () => {
    /** Without a description we can't compile the prompt. */
    expect(() => parseShorthand("foo:bool")).toThrow(ShorthandParseError);
  });

  it("rejects missing ':'", () => {
    /** Without a type the field is undefined. */
    expect(() => parseShorthand("foo=hello")).toThrow(/":"/);
  });

  it("rejects bad name regex", () => {
    /** Snake_case lowercase enforced. */
    expect(() => parseShorthand("BadName:bool=description ok")).toThrow(/name/);
    expect(() => parseShorthand("123:bool=description ok")).toThrow(/name/);
  });

  it("rejects bool with args", () => {
    /** No constraints make sense on bool. */
    expect(() => parseShorthand("flag:bool(1)=desc")).toThrow(/bool/);
  });

  it("rejects int range with non-integer bound", () => {
    /** Caller meant `number`, not `int`. */
    expect(() => parseShorthand("score:int(0.5-1.0)=desc")).toThrow(/int/);
  });

  it("rejects inverted range (min > max)", () => {
    /** Unsatisfiable schema. */
    expect(() => parseShorthand("score:int(10-1)=desc")).toThrow(/min/);
  });

  it("rejects unbalanced parentheses", () => {
    /** Malformed type spec. */
    expect(() => parseShorthand("score:int(1-10=desc")).toThrow(/unbalanced/);
  });

  it("rejects empty enum", () => {
    /** Empty enum cannot be represented in JSON Schema. */
    expect(() => parseShorthand("kind:enum()=desc")).toThrow(/enum/);
  });

  it("rejects unknown lowercase type kind", () => {
    /** Whitelist enforced for typos that pass the tokeniser regex. */
    expect(() => parseShorthand("x:blob=desc")).toThrow(/unknown/);
  });

  it("rejects type spec that fails the tokeniser regex (uppercase, etc.)", () => {
    /** Tokeniser only accepts lowercase identifiers — distinct error path. */
    expect(() => parseShorthand("x:Boolean=desc")).toThrow(/spec/);
  });
});

// ── parseShorthands batch helper ───────────────────────────────────────

describe("parseShorthands", () => {
  it("parses every entry in order", () => {
    /** Used by the CLI to fold N --field flags into a fields[] array. */
    const out = parseShorthands([
      "a:bool=desc a",
      "b:int(0-9)=desc b",
      "c:enum(x,y)=desc c",
    ]);
    expect(out.map((f) => f.name)).toEqual(["a", "b", "c"]);
    expect(out[1].type).toEqual({ kind: "int", min: 0, max: 9 });
  });

  it("propagates the per-entry error message", () => {
    /** Caller can map the failure back to the offending arg. */
    expect(() =>
      parseShorthands(["a:bool=ok", "broken-name:bool=ok"]),
    ).toThrow(/name/);
  });
});
