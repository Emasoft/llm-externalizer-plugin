/**
 * Scout-accuracy fixture module tests (TRDD-FKAR9VPK D1). Pure, hermetic —
 * no network (classifyPositional is exercised through the injected fetch seam).
 */

import { describe, it, expect } from "vitest";
import {
  buildPositionalSchema,
  classifyPositional,
  generateFixture,
  generateFixtureRecords,
  MIN_FIXTURE_BYTES,
  MIN_FIXTURE_RECORDS,
  scoreAccuracy,
  SCOUT_ACCURACY_FIXTURE_VERSION,
  SCOUT_CATEGORIES,
  OPENROUTER_BASE_URL,
} from "./scout-accuracy-fixture.js";

describe("scout-accuracy fixture generator (D1)", () => {
  it("MIN_FIXTURE_BYTES is the byte size of the 40-record minimum fixture (A9b)", () => {
    const min = generateFixtureRecords(1, MIN_FIXTURE_RECORDS);
    expect(MIN_FIXTURE_BYTES).toBe(Buffer.byteLength(min.body, "utf-8"));
    expect(min.recordCount).toBe(40);
  });

  it("is deterministic for a given seed", () => {
    const a = generateFixture(7, 50_000);
    const b = generateFixture(7, 50_000);
    expect(a.body).toBe(b.body);
    expect(a.expected).toEqual(b.expected);
    // A different seed changes the body.
    const c = generateFixture(8, 50_000);
    expect(c.body).not.toBe(a.body);
  });

  it("floors the record count at MIN_FIXTURE_RECORDS — never shrinks records (A9b)", () => {
    const tiny = generateFixture(1, 10);
    expect(tiny.recordCount).toBe(MIN_FIXTURE_RECORDS);
    expect(tiny.body.length).toBeGreaterThanOrEqual(MIN_FIXTURE_BYTES);
  });

  it("respects the target bytes at full records", () => {
    const target = 60_000;
    const f = generateFixture(1, target);
    expect(f.recordCount).toBeGreaterThan(MIN_FIXTURE_RECORDS);
    // Never more than one record past the target.
    const recMax = 320; // generous upper bound per record
    expect(f.body.length).toBeLessThanOrEqual(target + recMax);
  });

  it("ground truth is positional: expected[i] === SCOUT_CATEGORIES[i % N]", () => {
    const f = generateFixture(3, 20_000);
    f.expected.forEach((c, i) => {
      expect(c).toBe(SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]);
    });
  });
});

describe("positional schema + classifier (D1)", () => {
  it("buildPositionalSchema pins minItems/maxItems to the record count", () => {
    const schema = buildPositionalSchema(42) as {
      schema: { properties: { categories: { minItems: number; maxItems: number } } };
    };
    expect(schema.schema.properties.categories.minItems).toBe(42);
    expect(schema.schema.properties.categories.maxItems).toBe(42);
  });

  it("classifyPositional parses a good positional response through the fetch seam (A9a)", async () => {
    const fixture = generateFixture(1, MIN_FIXTURE_BYTES);
    const seen: { url: string; auth: string; model: string }[] = [];
    const fetchImpl = async (
      url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      const body = JSON.parse(init.body) as { model?: string };
      seen.push({ url, auth: init.headers.Authorization ?? "", model: body.model ?? "" });
      const payload = {
        choices: [{ message: { content: JSON.stringify({ categories: fixture.expected }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
    const res = await classifyPositional(
      "vendor/model-x",
      OPENROUTER_BASE_URL,
      "sk-test",
      fixture,
      buildPositionalSchema(fixture.recordCount),
      { fetchImpl },
    );
    expect(res.error).toBeNull();
    expect(res.predicted).toEqual(fixture.expected);
    expect(res.promptTokens).toBe(10);
    expect(seen[0]!.url).toBe(`${OPENROUTER_BASE_URL}/v1/chat/completions`);
    expect(seen[0]!.auth).toBe("Bearer sk-test");
    expect(seen[0]!.model).toBe("vendor/model-x");
  });

  it("surfaces non-parseable output as an error (the A4 structural probe refuses on this)", async () => {
    const fixture = generateFixture(1, MIN_FIXTURE_BYTES);
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "not json" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      text: async () => "",
    });
    const res = await classifyPositional(
      "vendor/model-x",
      OPENROUTER_BASE_URL,
      "sk-test",
      fixture,
      buildPositionalSchema(fixture.recordCount),
      { fetchImpl },
    );
    expect(res.error).toMatch(/JSON\.parse/);
    expect(res.predicted).toEqual([]);
  });

  it("surfaces HTTP errors", async () => {
    const fixture = generateFixture(1, MIN_FIXTURE_BYTES);
    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limited",
    });
    const res = await classifyPositional(
      "vendor/model-x",
      OPENROUTER_BASE_URL,
      "sk-test",
      fixture,
      buildPositionalSchema(fixture.recordCount),
      { fetchImpl },
    );
    expect(res.error).toMatch(/HTTP 429/);
  });
});

describe("scoreAccuracy (D1)", () => {
  it("scores positionally, denominator = expected length", () => {
    const s = scoreAccuracy(["a", "b", "c", "d"], ["a", "x", "c", "d"]);
    expect(s).toEqual({ correct: 3, total: 4, accuracy: 0.75 });
  });

  it("missing entries score as wrong; extras are ignored", () => {
    expect(scoreAccuracy(["a", "b", "c"], ["a"])).toEqual({ correct: 1, total: 3, accuracy: 1 / 3 });
    expect(scoreAccuracy(["a"], ["a", "b", "c"]).total).toBe(1);
  });

  it("zero-length expected scores 0 accuracy (never NaN)", () => {
    expect(scoreAccuracy([], [])).toEqual({ correct: 0, total: 0, accuracy: 0 });
  });
});

describe("fixture version constant", () => {
  it("is exported and pinned — a bump invalidates the ledger by design (F-2)", () => {
    expect(SCOUT_ACCURACY_FIXTURE_VERSION).toBe(1);
  });
});
