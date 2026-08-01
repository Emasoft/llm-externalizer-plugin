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
  rankByQualityIndex,
  isZeroCostPriced,
  isFreeModeEligible,
  freeSuffixOnly,
  resolveFreePool,
  extractCodexIndex,
  extractDesignArenaCodeElo,
  DEFAULT_CRITERIA,
  type OpenRouterModel,
  type QualifiedModel,
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
    // Propagated so quality-index tests can attach a realistic `benchmarks`
    // object. Defaults to undefined → existing tests' decorated models carry
    // codexIndex/designArenaElo: undefined, which `toEqual` ignores.
    benchmarks: overrides.benchmarks,
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

describe("benchmark/discover quality indexes (codex + design-arena, TRDD-WJND1N2W)", () => {
  // Realistic benchmarks object from the LIVE z-ai/glm-5.2 catalog entry
  // (research report 20260625_214644): coding_index 68.8, and a design_arena
  // list whose models/codecategories row has elo 1363. The other rows
  // (agents/fullstack, models/website) MUST be ignored by the code-ELO extractor.
  function withBenchmarks(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
    return makeModel({
      id: "z-ai/glm-5.2",
      benchmarks: {
        artificial_analysis: { intelligence_index: 51.1, coding_index: 68.8, agentic_index: 43.1 },
        design_arena: [
          { arena: "agents", category: "fullstack", elo: 1301, win_rate: 64.7, rank: 3 },
          { arena: "models", category: "codecategories", elo: 1363, win_rate: 62.2, rank: 1 },
          { arena: "models", category: "website", elo: 1357, win_rate: 61.5, rank: 1 },
        ],
      },
      ...overrides,
    });
  }

  // ── extractCodexIndex ───────────────────────────────────────────────
  it("extractCodexIndex returns artificial_analysis.coding_index when present", () => {
    expect(extractCodexIndex(withBenchmarks())).toBe(68.8);
  });

  it("extractCodexIndex returns undefined for every absent shape (no benchmarks / no AA / no field)", () => {
    expect(extractCodexIndex(makeModel())).toBeUndefined(); // no benchmarks key — the common case (most models)
    expect(extractCodexIndex(makeModel({ benchmarks: {} }))).toBeUndefined();
    expect(extractCodexIndex(makeModel({ benchmarks: { artificial_analysis: {} } }))).toBeUndefined();
  });

  it("extractCodexIndex returns undefined for a non-finite score (defensive against the under-documented field)", () => {
    expect(extractCodexIndex(makeModel({ benchmarks: { artificial_analysis: { coding_index: NaN } } }))).toBeUndefined();
    expect(
      extractCodexIndex(makeModel({ benchmarks: { artificial_analysis: { coding_index: Infinity } } })),
    ).toBeUndefined();
  });

  // ── extractDesignArenaCodeElo ───────────────────────────────────────
  it("extractDesignArenaCodeElo returns the models/codecategories row elo, ignoring all other rows", () => {
    // Must pick 1363 (models/codecategories), NOT 1301 (agents/fullstack) nor 1357 (models/website).
    expect(extractDesignArenaCodeElo(withBenchmarks())).toBe(1363);
  });

  it("extractDesignArenaCodeElo returns undefined unless an exact models+codecategories row exists", () => {
    expect(extractDesignArenaCodeElo(makeModel())).toBeUndefined(); // no benchmarks
    expect(extractDesignArenaCodeElo(makeModel({ benchmarks: { design_arena: [] } }))).toBeUndefined();
    // Right category but wrong arena ("agents", not "models") → not a match.
    expect(
      extractDesignArenaCodeElo(
        makeModel({ benchmarks: { design_arena: [{ arena: "agents", category: "codecategories", elo: 1300 }] } }),
      ),
    ).toBeUndefined();
    // Right arena but a different category → not a match.
    expect(
      extractDesignArenaCodeElo(
        makeModel({ benchmarks: { design_arena: [{ arena: "models", category: "website", elo: 1357 }] } }),
      ),
    ).toBeUndefined();
  });

  // ── decoration into QualifiedModel ──────────────────────────────────
  it("qualify decorates codexIndex + designArenaElo from the benchmarks object", () => {
    const q = qualify(withBenchmarks(), DEFAULT_CRITERIA);
    expect(q).not.toBeNull();
    expect(q!.codexIndex).toBe(68.8);
    expect(q!.designArenaElo).toBe(1363);
  });

  it("qualify leaves codexIndex/designArenaElo undefined for an unscored model (partial coverage is normal)", () => {
    const q = qualify(makeModel(), DEFAULT_CRITERIA);
    expect(q).not.toBeNull();
    expect(q!.codexIndex).toBeUndefined();
    expect(q!.designArenaElo).toBeUndefined();
  });

  it("buildBenchmarkRoster decorates requested baselines with the quality indexes too", () => {
    const scoredBaseline = withBenchmarks({
      pricing: { prompt: "0.00000125", completion: "0.00001" }, // over the $1/M budget → baseline-only
    });
    const { candidates, baselines } = buildBenchmarkRoster([scoredBaseline], DEFAULT_CRITERIA, ["z-ai/glm-5.2"]);
    expect(candidates).toEqual([]); // over budget → not an auto-candidate
    expect(baselines).toHaveLength(1);
    expect(baselines[0].codexIndex).toBe(68.8);
    expect(baselines[0].designArenaElo).toBe(1363);
  });

  // ── rankByQualityIndex ──────────────────────────────────────────────
  // Build a QualifiedModel via the real qualify() path with chosen indexes +
  // prices ($/M). All pass DEFAULT_CRITERIA; only the index/price axes vary.
  function qm(
    id: string,
    opts: { codex?: number; elo?: number; in?: number; out?: number } = {},
  ): QualifiedModel {
    const benchmarks: OpenRouterModel["benchmarks"] = {};
    if (opts.codex !== undefined) benchmarks.artificial_analysis = { coding_index: opts.codex };
    if (opts.elo !== undefined) {
      benchmarks.design_arena = [{ arena: "models", category: "codecategories", elo: opts.elo }];
    }
    const m = makeModel({
      id,
      pricing: {
        prompt: String((opts.in ?? 0.5) / 1_000_000),
        completion: String((opts.out ?? 0.5) / 1_000_000),
      },
      benchmarks: Object.keys(benchmarks).length > 0 ? benchmarks : undefined,
    });
    const q = qualify(m, DEFAULT_CRITERIA);
    if (!q) throw new Error(`test setup error: ${id} did not qualify`);
    return q;
  }

  it("rankByQualityIndex puts scored models above unscored ones, regardless of price", () => {
    // A missing index is UNKNOWN, not bad — but a model WITH evidence of quality
    // outranks an unscored one even when the unscored one is far cheaper.
    const cheapUnscored = qm("vendor/cheap-unscored", { in: 0.01, out: 0.01 });
    const scoredPricier = qm("vendor/scored", { codex: 50, elo: 1300, in: 0.9, out: 0.9 });
    expect(rankByQualityIndex([cheapUnscored, scoredPricier]).map((m) => m.id)).toEqual([
      "vendor/scored",
      "vendor/cheap-unscored",
    ]);
  });

  it("rankByQualityIndex orders scored models by higher composite quality first", () => {
    const lo = qm("vendor/lo", { codex: 40, elo: 1250 });
    const hi = qm("vendor/hi", { codex: 90, elo: 1400 });
    const mid = qm("vendor/mid", { codex: 65, elo: 1325 });
    expect(rankByQualityIndex([lo, hi, mid]).map((m) => m.id)).toEqual([
      "vendor/hi",
      "vendor/mid",
      "vendor/lo",
    ]);
  });

  it("rankByQualityIndex judges a one-axis model on the axis it has (not penalised for the missing one)", () => {
    // Each is the sole holder of its single axis → both normalise to 1.0 on that
    // axis → tie on composite score → the cheaper one wins the tiebreak.
    const codexOnly = qm("vendor/codex-only", { codex: 95, in: 0.8, out: 0.8 });
    const eloOnly = qm("vendor/elo-only", { elo: 1410, in: 0.2, out: 0.2 });
    expect(rankByQualityIndex([codexOnly, eloOnly]).map((m) => m.id)).toEqual([
      "vendor/elo-only",
      "vendor/codex-only",
    ]);
  });

  it("rankByQualityIndex breaks ties by cheapest and orders an all-unscored set purely by price", () => {
    const a = qm("vendor/a", { in: 0.5, out: 0.5 });
    const b = qm("vendor/b", { in: 0.1, out: 0.1 });
    const c = qm("vendor/c", { in: 0.3, out: 0.3 });
    // No indexes anywhere → all unscored → pure cheapest-first (prior behaviour preserved).
    expect(rankByQualityIndex([a, b, c]).map((m) => m.id)).toEqual(["vendor/b", "vendor/c", "vendor/a"]);
  });

  it("rankByQualityIndex is pure (no input mutation) and handles empty + singleton", () => {
    const input = [qm("vendor/x", { codex: 70 }), qm("vendor/y", { codex: 40 })];
    const before = input.map((m) => m.id);
    rankByQualityIndex(input);
    expect(input.map((m) => m.id)).toEqual(before); // input order untouched
    expect(rankByQualityIndex([])).toEqual([]);
    expect(rankByQualityIndex([input[0]]).map((m) => m.id)).toEqual(["vendor/x"]);
  });
});

describe("benchmark/discover zero-cost predicates (free-mode eligibility, TRDD-WJND1N2W P3)", () => {
  it("isZeroCostPriced is true ONLY when both axes are exactly 0", () => {
    expect(isZeroCostPriced(0, 0)).toBe(true);
    expect(isZeroCostPriced(0.1, 0)).toBe(false);
    expect(isZeroCostPriced(0, 0.1)).toBe(false);
    expect(isZeroCostPriced(0.1, 0.1)).toBe(false);
  });

  it("isZeroCostPriced treats NaN / Infinity (missing or unparseable pricing) as NOT free — fail-safe", () => {
    expect(isZeroCostPriced(NaN, 0)).toBe(false);
    expect(isZeroCostPriced(0, NaN)).toBe(false);
    expect(isZeroCostPriced(Infinity, 0)).toBe(false);
    expect(isZeroCostPriced(Infinity, Infinity)).toBe(false);
  });

  it("isFreeModeEligible admits a :free id regardless of its catalog price", () => {
    // A ':free' suffix is the historical guarantee — eligible even if the parsed
    // price is non-zero or unknown (the suffix IS OpenRouter's free-tier marker).
    expect(isFreeModeEligible("deepseek/deepseek-r1:free", 5, 5)).toBe(true);
    expect(isFreeModeEligible("x/y:free", NaN, NaN)).toBe(true);
  });

  it("isFreeModeEligible admits a price-0 model that LACKS the :free suffix (the owl-alpha case)", () => {
    expect(isFreeModeEligible("openrouter/owl-alpha", 0, 0)).toBe(true);
  });

  it("isFreeModeEligible REJECTS a priced no-suffix model — the critical zero-spend safety case", () => {
    // The whole point: a non-':free' model that costs money must NEVER pass the
    // free_only chokepoint, or free mode would silently bill.
    expect(isFreeModeEligible("vendor/cheap-but-paid", 0.01, 0.01)).toBe(false);
    expect(isFreeModeEligible("vendor/pricey", 5, 10)).toBe(false);
    // A baseline with no catalog price (Infinity) must also be rejected.
    expect(isFreeModeEligible("vendor/unknown-price", Infinity, Infinity)).toBe(false);
  });
});

describe("benchmark/discover resolveFreePool (free-pool verify + auto-discovery, TRDD-WJND1N2W P3b)", () => {
  const free = makeModel({ id: "vendor/x:free", pricing: { prompt: "0", completion: "0" } });
  const owl = makeModel({ id: "openrouter/owl-alpha", pricing: { prompt: "0", completion: "0" } });
  const paid = makeModel({ id: "vendor/paid", pricing: { prompt: "0.0000005", completion: "0.0000006" } });
  const freeNoStruct = makeModel({
    id: "vendor/free-nostruct",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["reasoning"], // no structured_outputs → fails the structural bar
  });
  const catalog = [free, owl, paid, freeNoStruct];

  it("admits a configured :free id + a configured price-0 no-suffix id; REJECTS a priced or absent non-:free id", () => {
    const r = resolveFreePool(
      ["vendor/x:free", "openrouter/owl-alpha", "vendor/paid", "vendor/ghost"],
      catalog,
      { autoDiscover: false, autoDiscoverTopN: 16 },
    );
    expect(r.pool).toContain("vendor/x:free"); // :free admitted as-is
    expect(r.pool).toContain("openrouter/owl-alpha"); // price-0 no-suffix proven by the catalog
    expect(r.rejected).toContain("vendor/paid"); // priced → rejected (would cost money)
    expect(r.rejected).toContain("vendor/ghost"); // absent from the catalog → rejected (fail-safe)
    expect(r.pool).not.toContain("vendor/paid");
    expect(r.pool).not.toContain("vendor/ghost");
    expect(r.autoDiscovered).toEqual([]); // autoDiscover off
  });

  it("auto-discovers structurally-qualified zero-cost models (incl. no-suffix owl-alpha); excludes priced / unqualified", () => {
    const r = resolveFreePool([], catalog, { autoDiscover: true, autoDiscoverTopN: 16 });
    expect(r.autoDiscovered).toContain("openrouter/owl-alpha"); // price-0 + qualified
    expect(r.autoDiscovered).toContain("vendor/x:free"); // :free + price-0 + qualified
    expect(r.autoDiscovered).not.toContain("vendor/paid"); // priced → excluded
    expect(r.autoDiscovered).not.toContain("vendor/free-nostruct"); // no structured output → excluded
    for (const id of r.autoDiscovered) expect(r.pool).toContain(id); // everything discovered is in the pool
  });

  it("respects autoDiscoverTopN and never duplicates a configured id it also discovers", () => {
    const capped = resolveFreePool([], catalog, { autoDiscover: true, autoDiscoverTopN: 1 });
    expect(capped.autoDiscovered.length).toBe(1); // cap honored
    const both = resolveFreePool(["openrouter/owl-alpha"], catalog, {
      autoDiscover: true,
      autoDiscoverTopN: 16,
    });
    expect(both.pool.filter((id) => id === "openrouter/owl-alpha")).toEqual(["openrouter/owl-alpha"]); // once
    expect(both.autoDiscovered).not.toContain("openrouter/owl-alpha"); // already counted as configured
  });
});

describe("benchmark/discover freeSuffixOnly (free_only send-eligibility filter — matches assertFreeOnlyModel)", () => {
  it("keeps ONLY the ':free'-suffixed id — a zero-cost ROUTER pseudo-model 'openrouter/free' is excluded", () => {
    // The exact regression: 'openrouter/free' is priced $0 so resolveFreePool auto-discovers
    // it, but it lacks the ':free' suffix — assertFreeOnlyModel would throw before its send,
    // aborting a whole --update-all --free sweep. The filter drops it, keeps the real :free id.
    expect(freeSuffixOnly(["openrouter/free", "vendor/x:free"])).toEqual(["vendor/x:free"]);
  });

  it("excludes EVERY non-':free' id (router / auto / no-suffix beta) even when the catalog prices them $0", () => {
    expect(
      freeSuffixOnly(["openrouter/free", "openrouter/auto", "openrouter/owl-alpha", "a:free", "b:free"]),
    ).toEqual(["a:free", "b:free"]);
  });

  it("is order-preserving, a no-op on an all-':free' list, and yields [] when nothing qualifies", () => {
    expect(freeSuffixOnly(["a:free", "b:free"])).toEqual(["a:free", "b:free"]);
    expect(freeSuffixOnly(["openrouter/free", "openrouter/auto"])).toEqual([]);
    expect(freeSuffixOnly([])).toEqual([]);
  });
});
