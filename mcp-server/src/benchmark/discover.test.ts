/**
 * Unit tests for the benchmark model-discovery filters (filterModels,
 * disqualifyReason, qualify, buildBenchmarkRoster).
 *
 * All four functions are PURE — they operate on already-fetched
 * OpenRouterModel objects with zero I/O — so every test constructs a
 * realistic in-memory model and asserts against the real decision. No
 * mocks. fetchProgrammingModels (the only network function) is OUT OF
 * SCOPE and is never called here.
 *
 * Coverage focus: filterModels include/exclude by criteria; each
 * disqualifying branch of disqualifyReason (free, structured, reasoning,
 * context, output-cap, pricing) and its null-when-qualified path;
 * qualify's accept→decorated-model / reject→null contract including the
 * strict (`<`, not `<=`) pricing boundary and the null-max_completion
 * normalisation; and buildBenchmarkRoster's candidate filtering plus
 * baseline lookup with de-duplication.
 */

import { describe, it, expect } from "vitest";
import {
  filterModels,
  disqualifyReason,
  qualify,
  buildBenchmarkRoster,
  DEFAULT_CRITERIA,
  type OpenRouterModel,
} from "./discover.js";

// ── realistic builder ─────────────────────────────────────────────────
// Produces a raw OpenRouter model that PASSES DEFAULT_CRITERIA by default
// (200K ctx, 64K max output, $0.50/M in + $0.60/M out, structured +
// reasoning, no :free suffix). Each test perturbs exactly one field to
// drive a single decision branch.
function makeModel(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: overrides.id ?? "vendor/model-a",
    name: overrides.name ?? "Model A",
    context_length: overrides.context_length ?? 200_000,
    pricing: overrides.pricing ?? { prompt: "0.0000005", completion: "0.0000006" },
    top_provider: overrides.top_provider ?? { context_length: 200_000, max_completion_tokens: 64_000 },
    supported_parameters: overrides.supported_parameters ?? ["structured_outputs", "reasoning"],
    created: overrides.created ?? 1_700_000_000,
  };
}

describe("benchmark/discover filters", () => {
  // ── filterModels ────────────────────────────────────────────────────

  it("filterModels keeps only the qualifying models and decorates them", () => {
    const good = makeModel({ id: "vendor/good", name: "Good Model" });
    const tooCheapContext = makeModel({ id: "vendor/short-ctx", context_length: 32_000 });
    const overPriced = makeModel({
      id: "vendor/pricey",
      pricing: { prompt: "0.000002", completion: "0.000002" }, // $2/M both → over $1/M cap
    });
    const result = filterModels([good, tooCheapContext, overPriced], DEFAULT_CRITERIA);
    expect(result.map((m) => m.id)).toEqual(["vendor/good"]);
    // Decorated fields are derived from the raw model, not the defaults.
    expect(result[0].name).toBe("Good Model");
    expect(result[0].contextTokens).toBe(200_000);
    expect(result[0].inputDollarsPerMillion).toBeCloseTo(0.5, 10);
    expect(result[0].raw).toBe(good);
  });

  it("filterModels returns an empty array when no model meets the criteria", () => {
    const all = [
      makeModel({ id: "vendor/no-reasoning", supported_parameters: ["structured_outputs"] }),
      makeModel({ id: "vendor/no-structured", supported_parameters: ["reasoning"] }),
      makeModel({ id: "vendor/tiny", context_length: 8_000 }),
    ];
    expect(filterModels(all, DEFAULT_CRITERIA)).toEqual([]);
  });

  it("filterModels honours relaxed criteria (allowFree + no capability requirements)", () => {
    const freeBare = makeModel({
      id: "vendor/model:free",
      supported_parameters: [], // no structured, no reasoning
    });
    // Default criteria would reject (free + missing capabilities); a relaxed
    // criteria that drops those requirements lets it through.
    const relaxed = {
      ...DEFAULT_CRITERIA,
      allowFree: true,
      requireStructuredOutputs: false,
      requireReasoning: false,
    };
    expect(filterModels([freeBare], DEFAULT_CRITERIA)).toEqual([]);
    const kept = filterModels([freeBare], relaxed);
    expect(kept.map((m) => m.id)).toEqual(["vendor/model:free"]);
    expect(kept[0].supportsStructured).toBe(false);
    expect(kept[0].supportsReasoning).toBe(false);
  });

  // ── disqualifyReason ────────────────────────────────────────────────

  it("disqualifyReason returns null for a fully qualifying model", () => {
    expect(disqualifyReason(makeModel(), DEFAULT_CRITERIA)).toBeNull();
  });

  it("disqualifyReason flags the :free suffix when allowFree is false", () => {
    const freeModel = makeModel({ id: "deepseek/deepseek-r1:free" });
    expect(disqualifyReason(freeModel, DEFAULT_CRITERIA)).toBe(
      "free model not allowed (allowFree=false)",
    );
    // ...but is accepted when allowFree is true (other criteria still hold).
    expect(disqualifyReason(freeModel, { ...DEFAULT_CRITERIA, allowFree: true })).toBeNull();
  });

  it("disqualifyReason reports the specific failing capability/budget criterion", () => {
    // Missing reasoning support.
    expect(
      disqualifyReason(makeModel({ supported_parameters: ["structured_outputs"] }), DEFAULT_CRITERIA),
    ).toBe("no reasoning support");
    // Missing structured-output support.
    expect(
      disqualifyReason(makeModel({ supported_parameters: ["reasoning"] }), DEFAULT_CRITERIA),
    ).toBe("no structured-output support (needs response_format or structured_outputs)");
    // Context below the floor.
    expect(disqualifyReason(makeModel({ context_length: 64_000 }), DEFAULT_CRITERIA)).toBe(
      "context 64000 < required 128000",
    );
    // Invalid pricing (parseFloat → NaN).
    expect(
      disqualifyReason(makeModel({ pricing: { prompt: undefined, completion: "0.0000006" } }), DEFAULT_CRITERIA),
    ).toBe("missing or invalid pricing");
  });

  // ── qualify ─────────────────────────────────────────────────────────

  it("qualify accepts a model and returns the decorated QualifiedModel", () => {
    const m = makeModel({
      id: "google/gemini-3-flash",
      name: "Gemini 3 Flash",
      context_length: 1_000_000,
      pricing: { prompt: "0.0000003", completion: "0.0000006" },
      top_provider: { context_length: 1_000_000, max_completion_tokens: 128_000 },
      supported_parameters: ["response_format", "include_reasoning"], // alternate capability names
    });
    const q = qualify(m, DEFAULT_CRITERIA);
    expect(q).not.toBeNull();
    expect(q).toEqual({
      id: "google/gemini-3-flash",
      name: "Gemini 3 Flash",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      inputDollarsPerMillion: 0.3,
      outputDollarsPerMillion: 0.6,
      supportsStructured: true,
      supportsReasoning: true,
      raw: m,
    });
  });

  it("qualify enforces the strict (<, not <=) $1/M ceiling at the boundary", () => {
    // Exactly $1.00/M out → rejected (>= cap). $0.999999/M out → accepted.
    const atCap = makeModel({
      id: "vendor/at-cap",
      pricing: { prompt: "0.0000005", completion: "0.000001" }, // out = $1.00/M
    });
    const justUnder = makeModel({
      id: "vendor/just-under",
      pricing: { prompt: "0.0000005", completion: "0.000000999999" }, // out ≈ $0.999999/M
    });
    expect(qualify(atCap, DEFAULT_CRITERIA)).toBeNull();
    expect(disqualifyReason(atCap, DEFAULT_CRITERIA)).toBe(
      "output $1.000/M >= cap $1.000/M",
    );
    const ok = qualify(justUnder, DEFAULT_CRITERIA);
    expect(ok).not.toBeNull();
    expect(ok!.outputDollarsPerMillion).toBeLessThan(1.0);
  });

  it("qualify normalises null max_completion_tokens to context length and falls back name→id", () => {
    // null max_completion_tokens means "no cap below context" → treat as ctx,
    // which (300K) clears the 64K output floor. Also: name omitted → id used.
    // (Delete `name` outright — the builder's `?? "Model A"` default would
    // otherwise hide the real raw-model `name: undefined` we want to test.)
    const noCap = makeModel({
      id: "z-ai/glm-5",
      context_length: 300_000,
      top_provider: { context_length: 300_000, max_completion_tokens: null },
    });
    delete noCap.name;
    const q = qualify(noCap, DEFAULT_CRITERIA);
    expect(q).not.toBeNull();
    expect(q!.name).toBe("z-ai/glm-5");
    expect(q!.maxOutputTokens).toBe(300_000);

    // A MISSING (undefined) field stays 0 → rejected by the output floor.
    const noField = makeModel({
      id: "vendor/no-output-info",
      top_provider: { context_length: 200_000 },
    });
    expect(qualify(noField, DEFAULT_CRITERIA)).toBeNull();
    expect(disqualifyReason(noField, DEFAULT_CRITERIA)).toBe("max output 0 < required 64000");
  });

  // ── buildBenchmarkRoster ────────────────────────────────────────────

  it("buildBenchmarkRoster filters candidates and appends only requested baselines", () => {
    const cand = makeModel({ id: "vendor/cand" });
    const rejected = makeModel({ id: "vendor/rejected", context_length: 16_000 });
    // A baseline that exceeds the budget — kept anyway because it was requested
    // by name, and its best-effort numeric fields are computed.
    const expensiveBaseline = makeModel({
      id: "openai/gpt-5",
      name: "GPT-5",
      pricing: { prompt: "0.00000125", completion: "0.00001" }, // $1.25/M in, $10/M out
    });
    const pool = [cand, rejected, expensiveBaseline];
    const { candidates, baselines } = buildBenchmarkRoster(
      pool,
      DEFAULT_CRITERIA,
      ["openai/gpt-5", "vendor/does-not-exist"], // unknown id silently skipped
    );
    expect(candidates.map((m) => m.id)).toEqual(["vendor/cand"]);
    expect(baselines.map((m) => m.id)).toEqual(["openai/gpt-5"]);
    expect(baselines[0].name).toBe("GPT-5");
    expect(baselines[0].inputDollarsPerMillion).toBeCloseTo(1.25, 10);
    expect(baselines[0].outputDollarsPerMillion).toBeCloseTo(10, 10);
  });

  it("buildBenchmarkRoster de-duplicates baselines against candidates and within includeIds", () => {
    const shared = makeModel({ id: "vendor/shared" }); // qualifies as a candidate
    const extra = makeModel({ id: "vendor/extra-baseline", context_length: 16_000 }); // baseline only
    const pool = [shared, extra];
    const { candidates, baselines } = buildBenchmarkRoster(
      pool,
      DEFAULT_CRITERIA,
      // "vendor/shared" already a candidate → dropped; "vendor/extra-baseline"
      // listed twice → added once.
      ["vendor/shared", "vendor/extra-baseline", "vendor/extra-baseline"],
    );
    expect(candidates.map((m) => m.id)).toEqual(["vendor/shared"]);
    expect(baselines.map((m) => m.id)).toEqual(["vendor/extra-baseline"]);
  });
});
