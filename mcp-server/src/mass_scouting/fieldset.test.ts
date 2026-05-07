/**
 * Unit tests for the mass-scouting fieldset DSL.
 *
 * Covers:
 *   • parseFieldset — happy + ten failure shapes (bad version, bad regexes,
 *     out-of-bounds description, missing fields, duplicate names, etc.)
 *   • parseFieldType — every kind, with their respective constraint failures
 *   • compileFieldset — snapshot-equivalent assertions on the generated JSON
 *     schema (name, additionalProperties:false, required[], every property)
 *   • compileFieldset.systemPrompt — every field name + description present
 *   • compileFieldset.userPromptFor — envelope shape
 *   • compileFieldset.validate — accepts valid, rejects non-object, rejects
 *     missing required keys
 *   • compileFieldset.repair — bool coercion, string truncate-at-boundary,
 *     enum case-insensitive + Levenshtein snap, array trim + dedup,
 *     int round + clamp, number parse + clamp, missing required keys
 *     filled with defaults, extra keys dropped, top-level non-object handled
 */

import { describe, it, expect } from "vitest";
import {
  parseFieldset,
  compileFieldset,
  FieldsetParseError,
  type ScoutFieldset,
} from "./fieldset";

const VALID_EXAMPLE: ScoutFieldset = {
  version: 1,
  fieldset_name: "ts-code-audit",
  notes: "Audit TypeScript files for async/test/complexity signals.",
  fields: [
    {
      name: "is_async",
      type: { kind: "bool" },
      description: "True if the file uses async/await constructs.",
    },
    {
      name: "frameworks",
      type: { kind: "array_string", max_items: 8 },
      description: "Frameworks/libraries the file imports or extends.",
    },
    {
      name: "test_kind",
      type: {
        kind: "enum",
        values: ["none", "unit", "integration", "e2e", "snapshot"],
      },
      description: "What kind of test (if any) this file is.",
    },
    {
      name: "complexity_1_to_10",
      type: { kind: "int", min: 1, max: 10 },
      description: "Subjective complexity score from 1 to 10.",
    },
    {
      name: "summary",
      type: { kind: "string", max_length: 200 },
      description: "One-sentence summary of what the file does.",
    },
    {
      name: "confidence",
      type: { kind: "number", min: 0, max: 1 },
      description: "Confidence in the extraction, 0..1.",
    },
    {
      name: "tags",
      type: {
        kind: "array_enum",
        values: ["api", "ui", "data", "test", "config"],
        max_items: 3,
      },
      description: "Up to three categorical tags.",
    },
  ],
};

// ── parseFieldset ──────────────────────────────────────────────────────

describe("parseFieldset", () => {
  it("accepts a fully-populated valid fieldset and returns a deep copy", () => {
    /** Round-trip the canonical example through the parser; ensure structural fidelity. */
    const out = parseFieldset(VALID_EXAMPLE);
    expect(out).toEqual(VALID_EXAMPLE);
    expect(out).not.toBe(VALID_EXAMPLE);
    expect(out.fields).not.toBe(VALID_EXAMPLE.fields);
  });

  it("accepts a minimal fieldset (no notes, single field)", () => {
    /** Optional `notes` is genuinely optional. */
    const minimal = {
      version: 1,
      fieldset_name: "min",
      fields: [
        {
          name: "ok",
          type: { kind: "bool" },
          description: "is the file ok",
        },
      ],
    };
    expect(parseFieldset(minimal)).toEqual(minimal);
  });

  it("rejects non-object root", () => {
    /** Defensive: callers may stuff arbitrary unknown values from JSON.parse. */
    expect(() => parseFieldset(null)).toThrow(FieldsetParseError);
    expect(() => parseFieldset([])).toThrow(/root/);
    expect(() => parseFieldset("hello")).toThrow(/root/);
  });

  it("rejects wrong version", () => {
    /** Forward-compat: version locks the schema shape. */
    expect(() =>
      parseFieldset({ ...VALID_EXAMPLE, version: 2 }),
    ).toThrow(/version/);
  });

  it("rejects fieldset_name that does not match the regex", () => {
    /** Names that aren't snake/kebab become unsafe identifiers downstream. */
    expect(() =>
      parseFieldset({ ...VALID_EXAMPLE, fieldset_name: "Has-CAPS" }),
    ).toThrow(/fieldset_name/);
    expect(() =>
      parseFieldset({ ...VALID_EXAMPLE, fieldset_name: "" }),
    ).toThrow(/fieldset_name/);
  });

  it("rejects notes longer than 1000 chars", () => {
    /** Soft cap to keep the system prompt reasonable. */
    expect(() =>
      parseFieldset({ ...VALID_EXAMPLE, notes: "x".repeat(1_001) }),
    ).toThrow(/notes/);
  });

  it("rejects empty fields array", () => {
    /** A fieldset with zero fields would compile to a useless empty schema. */
    expect(() =>
      parseFieldset({ ...VALID_EXAMPLE, fields: [] }),
    ).toThrow(/fields/);
  });

  it("rejects more than 64 fields", () => {
    /** Hard upper bound to stop pathological prompts. */
    const fields = Array.from({ length: 65 }, (_, i) => ({
      name: `f${i}`,
      type: { kind: "bool" },
      description: "valid description",
    }));
    expect(() =>
      parseFieldset({ ...VALID_EXAMPLE, fields }),
    ).toThrow(/64/);
  });

  it("rejects duplicate field names", () => {
    /** JSON object collisions would silently drop fields if we didn't check. */
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "x",
            type: { kind: "bool" },
            description: "first one",
          },
          {
            name: "x",
            type: { kind: "string" },
            description: "second one",
          },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects bad field name", () => {
    /** Snake_case lowercase is a hard rule for JSON-key safety. */
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "BadName",
            type: { kind: "bool" },
            description: "valid description",
          },
        ],
      }),
    ).toThrow(/name/);
  });

  it("rejects out-of-bounds description length", () => {
    /** 5..280 chars: too short = vague prompt, too long = wasted tokens. */
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "x",
            type: { kind: "bool" },
            description: "hi",
          },
        ],
      }),
    ).toThrow(/description/);
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "x",
            type: { kind: "bool" },
            description: "x".repeat(281),
          },
        ],
      }),
    ).toThrow(/description/);
  });

  it("rejects unknown type kind", () => {
    /** Strict whitelist — typos surface immediately. */
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "x",
            type: { kind: "Boolean" },
            description: "valid description",
          },
        ],
      }),
    ).toThrow(/kind/);
  });

  it("rejects enum without values", () => {
    /** Empty enum cannot be represented in a JSON schema. */
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "x",
            type: { kind: "enum", values: [] },
            description: "valid description",
          },
        ],
      }),
    ).toThrow(/values/);
  });

  it("rejects int.min > int.max", () => {
    /** Inverted ranges produce an unsatisfiable schema. */
    expect(() =>
      parseFieldset({
        ...VALID_EXAMPLE,
        fields: [
          {
            name: "x",
            type: { kind: "int", min: 10, max: 1 },
            description: "valid description",
          },
        ],
      }),
    ).toThrow(/min/);
  });
});

// ── compileFieldset — JSON Schema shape ────────────────────────────────

describe("compileFieldset.jsonSchema", () => {
  it("uses a sanitised name and strict:true", () => {
    /** OpenRouter requires strict:true to enforce additionalProperties:false. */
    const c = compileFieldset(VALID_EXAMPLE);
    expect(c.jsonSchema.name).toBe("mass_scout_ts_code_audit");
    expect(c.jsonSchema.strict).toBe(true);
  });

  it("locks the object shape: additionalProperties:false + every required field", () => {
    /** Required list = every field that doesn't opt out via required:false. */
    const c = compileFieldset(VALID_EXAMPLE);
    expect(c.jsonSchema.schema.type).toBe("object");
    expect(c.jsonSchema.schema.additionalProperties).toBe(false);
    expect(c.jsonSchema.schema.required.sort()).toEqual(
      [
        "is_async",
        "frameworks",
        "test_kind",
        "complexity_1_to_10",
        "summary",
        "confidence",
        "tags",
      ].sort(),
    );
  });

  it("drops fields with required:false from the required list but keeps them in properties", () => {
    /** Optional fields must still be schema-described so the model can emit them. */
    const fs: ScoutFieldset = {
      version: 1,
      fieldset_name: "mixed",
      fields: [
        {
          name: "must",
          type: { kind: "bool" },
          description: "required field",
        },
        {
          name: "maybe",
          type: { kind: "string" },
          description: "optional field",
          required: false,
        },
      ],
    };
    const c = compileFieldset(fs);
    expect(c.jsonSchema.schema.required).toEqual(["must"]);
    expect(c.jsonSchema.schema.properties).toHaveProperty("must");
    expect(c.jsonSchema.schema.properties).toHaveProperty("maybe");
  });

  it("maps each kind to the correct JSON Schema property type", () => {
    /** Single contract test catches any future refactor that breaks a mapping. */
    const c = compileFieldset(VALID_EXAMPLE);
    const p = c.jsonSchema.schema.properties;
    expect(p.is_async.type).toBe("boolean");
    expect(p.frameworks.type).toBe("array");
    expect(p.frameworks.items?.type).toBe("string");
    expect(p.frameworks.maxItems).toBe(8);
    expect(p.test_kind.type).toBe("string");
    expect(p.test_kind.enum).toEqual([
      "none",
      "unit",
      "integration",
      "e2e",
      "snapshot",
    ]);
    expect(p.complexity_1_to_10.type).toBe("integer");
    expect(p.complexity_1_to_10.minimum).toBe(1);
    expect(p.complexity_1_to_10.maximum).toBe(10);
    expect(p.summary.type).toBe("string");
    expect(p.summary.maxLength).toBe(200);
    expect(p.confidence.type).toBe("number");
    expect(p.confidence.minimum).toBe(0);
    expect(p.confidence.maximum).toBe(1);
    expect(p.tags.type).toBe("array");
    expect(p.tags.items?.enum).toEqual(["api", "ui", "data", "test", "config"]);
    expect(p.tags.maxItems).toBe(3);
  });

  it("copies field descriptions verbatim into schema.description (model uses them)", () => {
    /** Some providers honour schema descriptions when constraining output. */
    const c = compileFieldset(VALID_EXAMPLE);
    expect(c.jsonSchema.schema.properties.is_async.description).toContain(
      "async/await",
    );
  });
});

// ── compileFieldset — system + user prompt ─────────────────────────────

describe("compileFieldset.systemPrompt", () => {
  it("mentions every field name and description verbatim", () => {
    /** The prompt is the model's primary signal — every field must surface. */
    const c = compileFieldset(VALID_EXAMPLE);
    for (const f of VALID_EXAMPLE.fields) {
      expect(c.systemPrompt).toContain(`"${f.name}"`);
      expect(c.systemPrompt).toContain(f.description);
    }
  });

  it("includes notes when provided and skips them when absent", () => {
    /** The notes block is rendered conditionally to avoid an empty section. */
    const cWith = compileFieldset(VALID_EXAMPLE);
    expect(cWith.systemPrompt).toContain("Audit TypeScript files");
    const cWithout = compileFieldset({
      version: 1,
      fieldset_name: "x",
      fields: [
        {
          name: "ok",
          type: { kind: "bool" },
          description: "is it ok",
        },
      ],
    });
    expect(cWithout.systemPrompt).not.toMatch(/NOTES \(from the user\):/);
  });
});

describe("compileFieldset.userPromptFor", () => {
  it("renders the FILE/CONTENT envelope", () => {
    /** Body is sent verbatim — caller is responsible for the size cap. */
    const c = compileFieldset(VALID_EXAMPLE);
    const out = c.userPromptFor("foo.ts", "const x = 1;\n");
    expect(out).toBe("FILE: foo.ts\n\nCONTENT:\nconst x = 1;\n");
  });
});

// ── compileFieldset — validate ─────────────────────────────────────────

describe("compileFieldset.validate", () => {
  it("accepts a fully-populated object", () => {
    /** Happy path: every required key present. */
    const c = compileFieldset(VALID_EXAMPLE);
    const result = c.validate({
      is_async: true,
      frameworks: ["react"],
      test_kind: "none",
      complexity_1_to_10: 5,
      summary: "summary",
      confidence: 0.9,
      tags: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object", () => {
    /** Some providers return null when they fail to honour the schema. */
    const c = compileFieldset(VALID_EXAMPLE);
    expect(c.validate(null).ok).toBe(false);
    expect(c.validate([]).ok).toBe(false);
    expect(c.validate("hello").ok).toBe(false);
  });

  it("reports which keys are missing", () => {
    /** Drives the retry-with-feedback loop in the scout phase. */
    const c = compileFieldset(VALID_EXAMPLE);
    const result = c.validate({ is_async: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("missing");
    expect(result.reason).toContain("frameworks");
    expect(result.reason).toContain("test_kind");
  });
});

// ── compileFieldset — repair ───────────────────────────────────────────

describe("compileFieldset.repair", () => {
  it("coerces truthy/falsy strings to booleans", () => {
    /** Models occasionally emit "true" / "yes" / 1 instead of true. */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "b",
      fields: [
        {
          name: "flag",
          type: { kind: "bool" },
          description: "the flag",
        },
      ],
    });
    expect(c.repair({ flag: "yes" }).repaired.flag).toBe(true);
    expect(c.repair({ flag: 0 }).repaired.flag).toBe(false);
    expect(c.repair({ flag: "TRUE" }).repaired.flag).toBe(true);
  });

  it("truncates over-cap strings at the last whitespace boundary", () => {
    /** Per blueprint §3.5: prefer hyphen/space cuts over hard slices. */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "s",
      fields: [
        {
          name: "summary",
          type: { kind: "string", max_length: 20 },
          description: "short summary please",
        },
      ],
    });
    const out = c.repair({
      summary: "this is way too long to fit in twenty chars I promise",
    });
    expect((out.repaired.summary as string).length).toBeLessThanOrEqual(20);
    expect(out.repairs[0]).toMatch(/truncated/);
  });

  it("snaps enum values via case-insensitive then Levenshtein", () => {
    /** Common drift: model returns "Unit" instead of "unit". */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "e",
      fields: [
        {
          name: "kind",
          type: { kind: "enum", values: ["none", "unit", "integration"] },
          description: "test kind",
        },
      ],
    });
    expect(c.repair({ kind: "Unit" }).repaired.kind).toBe("unit");
    // Levenshtein-2 snap: integratin → integration
    expect(c.repair({ kind: "integratin" }).repaired.kind).toBe("integration");
  });

  it("trims arrays to max_items and dedupes duplicates", () => {
    /** Models sometimes repeat a tag; we always dedupe before trimming. */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "a",
      fields: [
        {
          name: "frameworks",
          type: { kind: "array_string", max_items: 2 },
          description: "frameworks used",
        },
      ],
    });
    const out = c.repair({ frameworks: ["react", "react", "vue", "ember"] });
    expect(out.repaired.frameworks).toEqual(["react", "vue"]);
    expect(out.repairs.some((r) => r.includes("duplicate"))).toBe(true);
    expect(out.repairs.some((r) => r.includes("trimmed"))).toBe(true);
  });

  it("rounds floats to integers and clamps to range", () => {
    /** Most cheap models emit 7.0 for ints — tolerate that. */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "i",
      fields: [
        {
          name: "score",
          type: { kind: "int", min: 1, max: 10 },
          description: "1..10 score",
        },
      ],
    });
    expect(c.repair({ score: 7.4 }).repaired.score).toBe(7);
    expect(c.repair({ score: 100 }).repaired.score).toBe(10);
    expect(c.repair({ score: -5 }).repaired.score).toBe(1);
    expect(c.repair({ score: "7" }).repaired.score).toBe(7);
  });

  it("clamps floats to numeric range and parses string numbers", () => {
    /** Confidence-style fields often come back as "0.85". */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "n",
      fields: [
        {
          name: "conf",
          type: { kind: "number", min: 0, max: 1 },
          description: "confidence",
        },
      ],
    });
    expect(c.repair({ conf: "0.85" }).repaired.conf).toBe(0.85);
    expect(c.repair({ conf: 1.4 }).repaired.conf).toBe(1);
    expect(c.repair({ conf: -0.1 }).repaired.conf).toBe(0);
  });

  it("fills missing required keys with type-default and logs the repair", () => {
    /** Paired with the validator, this turns silent-drop into a logged repair. */
    const c = compileFieldset(VALID_EXAMPLE);
    const out = c.repair({});
    expect(out.repaired).toEqual({
      is_async: false,
      frameworks: [],
      test_kind: "none",
      complexity_1_to_10: 1,
      summary: "",
      confidence: 0,
      tags: [],
    });
    expect(out.repairs.length).toBeGreaterThanOrEqual(7);
  });

  it("drops keys that aren't in the fieldset (additionalProperties:false)", () => {
    /** Model invented a key — log and discard. */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "x",
      fields: [
        {
          name: "ok",
          type: { kind: "bool" },
          description: "is it ok",
        },
      ],
    });
    const out = c.repair({ ok: true, unwanted: "noise" });
    expect(out.repaired).toEqual({ ok: true });
    expect(out.repairs.some((r) => r.includes("unwanted"))).toBe(true);
  });

  it("treats top-level non-object as empty + logs", () => {
    /** Some providers emit `[]` or `null` even with strict:true. */
    const c = compileFieldset({
      version: 1,
      fieldset_name: "x",
      fields: [
        {
          name: "ok",
          type: { kind: "bool" },
          description: "is it ok",
        },
      ],
    });
    const out = c.repair([1, 2, 3]);
    expect(out.repaired).toEqual({ ok: false });
    expect(out.repairs[0]).toMatch(/top-level/);
  });
});

// ── array_object (positional list of records) ──────────────────────────

describe("array_object — positional semantics", () => {
  /** Fieldset with one positional list-of-records field. */
  function tweetClassFieldset(exact?: number): unknown {
    const type: Record<string, unknown> = {
      kind: "array_object",
      item_fields: [
        {
          name: "category",
          description: "topic of the tweet",
          type: { kind: "enum", values: ["sport", "music", "code"] },
        },
        {
          name: "is_urgent",
          description: "true if marked urgent",
          type: { kind: "bool" },
        },
      ],
    };
    if (exact !== undefined) type.exact_items = exact;
    return {
      version: 1,
      fieldset_name: "tweet-class",
      fields: [
        {
          name: "tweets",
          description: "one classification per tweet, in input order",
          type,
        },
      ],
    };
  }

  it("parses an array_object field with item_fields", () => {
    /** Smoke test: round-trip through parseFieldset succeeds. */
    const fs = parseFieldset(tweetClassFieldset());
    expect(fs.fields[0]!.type.kind).toBe("array_object");
  });

  it("rejects an empty item_fields list", () => {
    /** array_object with no shape is meaningless. */
    expect(() =>
      parseFieldset({
        version: 1,
        fieldset_name: "x",
        fields: [
          {
            name: "x",
            description: "placeholder",
            type: { kind: "array_object", item_fields: [] },
          },
        ],
      }),
    ).toThrow(/non-empty array/);
  });

  it("rejects nested array_object inside array_object (no recursion)", () => {
    /** Keeps repair tractable; flat sub-fields only. */
    expect(() =>
      parseFieldset({
        version: 1,
        fieldset_name: "x",
        fields: [
          {
            name: "x",
            description: "placeholder",
            type: {
              kind: "array_object",
              item_fields: [
                {
                  name: "inner",
                  description: "no",
                  type: {
                    kind: "array_object",
                    item_fields: [
                      {
                        name: "deep",
                        description: "z",
                        type: { kind: "bool" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toThrow(/cannot be array_object/);
  });

  it("rejects exact_items together with min_items/max_items", () => {
    /** Mutually exclusive — caller must pick one. */
    expect(() =>
      parseFieldset({
        version: 1,
        fieldset_name: "x",
        fields: [
          {
            name: "x",
            description: "placeholder",
            type: {
              kind: "array_object",
              item_fields: [
                { name: "a", description: "a", type: { kind: "bool" } },
              ],
              exact_items: 3,
              max_items: 5,
            },
          },
        ],
      }),
    ).toThrow(/mutually exclusive/);
  });

  it("compiles to a JSON Schema with array-of-object items", () => {
    /** strict:true requires `additionalProperties:false` on the item. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset()));
    const prop = c.jsonSchema.schema.properties["tweets"]!;
    expect(prop.type).toBe("array");
    expect(prop.items?.type).toBe("object");
    expect(prop.items?.additionalProperties).toBe(false);
    expect(prop.items?.required).toContain("category");
    expect(prop.items?.required).toContain("is_urgent");
  });

  it("emits minItems = maxItems = exact_items when set", () => {
    /** Force the model to return exactly N items. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset(7)));
    const prop = c.jsonSchema.schema.properties["tweets"]!;
    expect(prop.minItems).toBe(7);
    expect(prop.maxItems).toBe(7);
  });

  it("repair preserves positional order and never dedups", () => {
    /** This is THE calibration-killing bug fix: same-value adjacent items
     *  must NOT be collapsed. Without this the per-tweet classification
     *  pattern silently produced wrong-length arrays. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset()));
    const out = c.repair({
      tweets: [
        { category: "sport", is_urgent: false },
        { category: "sport", is_urgent: false },
        { category: "music", is_urgent: false },
        { category: "sport", is_urgent: false },
      ],
    });
    const tweets = out.repaired["tweets"] as { category: string }[];
    expect(tweets.length).toBe(4);
    expect(tweets.map((t) => t.category)).toEqual([
      "sport",
      "sport",
      "music",
      "sport",
    ]);
  });

  it("repair fills missing required sub-fields with defaults", () => {
    /** Per-subfield defaulting mirrors top-level field repair. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset()));
    const out = c.repair({
      tweets: [{ category: "sport" }],
    });
    const tweets = out.repaired["tweets"] as Record<string, unknown>[];
    expect(tweets[0]!["is_urgent"]).toBe(false);
    expect(out.repairs.some((r) => r.includes("is_urgent"))).toBe(true);
  });

  it("repair pads to exact_items when the model returned too few", () => {
    /** Common provider failure mode — returns N-1 items for an N-item array. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset(5)));
    const out = c.repair({
      tweets: [
        { category: "sport", is_urgent: false },
        { category: "music", is_urgent: false },
      ],
    });
    const tweets = out.repaired["tweets"] as unknown[];
    expect(tweets.length).toBe(5);
    expect(out.repairs.some((r) => /padded/.test(r))).toBe(true);
  });

  it("repair trims to exact_items when the model returned too many", () => {
    /** Equally common: model returns 1.5x or 6x what was asked for. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset(2)));
    const out = c.repair({
      tweets: Array.from({ length: 10 }, () => ({
        category: "sport",
        is_urgent: false,
      })),
    });
    const tweets = out.repaired["tweets"] as unknown[];
    expect(tweets.length).toBe(2);
    expect(out.repairs.some((r) => /trimmed/.test(r))).toBe(true);
  });

  it("repair coerces non-object items to {} + warns", () => {
    /** Defensive: a string in the items array shouldn't crash repair. */
    const c = compileFieldset(parseFieldset(tweetClassFieldset()));
    const out = c.repair({ tweets: ["bogus", { category: "sport" }] });
    const tweets = out.repaired["tweets"] as Record<string, unknown>[];
    expect(tweets.length).toBe(2);
    expect(out.repairs.some((r) => /not an object/.test(r))).toBe(true);
  });
});
