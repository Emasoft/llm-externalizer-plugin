/**
 * Unit tests for the benchmark report renderers (renderJson + renderReport).
 *
 * Both functions are PURE — they build strings from a ReportInput object
 * with zero I/O — so every test feeds a realistic, fully-populated input
 * and asserts against the real output string / parsed JSON. No mocks.
 *
 * Coverage focus: JSON sidecar shape for ok/error outcomes, markdown
 * content + number formatting (percentages, $costs, token counts), stable
 * mean-F1 ranking, per-keyword false-positive/missed/exact branches, the
 * roster table's finite-vs-infinite baseline price branch, and the
 * empty-results degenerate case.
 */

import { describe, it, expect } from "vitest";
import { renderJson, renderReport, type ReportInput } from "./report.js";
import type { GroundTruth } from "./ground-truth.js";
import type { QualifiedModel } from "./discover.js";
import type { RunResult, RunError, RunOutcome } from "./runner.js";
import type { ModelScore, PerKeywordScore } from "./score.js";

// ── realistic builders ────────────────────────────────────────────────

function makeTruth(): GroundTruth {
  return {
    keywords: ["JSON.parse(", "new URLSearchParams", "performance.now()"],
    keywordFunctions: [
      ["parseConfig", "decodePayload"],
      ["buildQuery"],
      ["measureLatency", "timeBlock", "tick"],
    ],
    noiseFunctions: ["helperA", "helperB", "helperC", "helperD"],
    // 2 + 1 + 3 keyworded + 4 noise = 10 total.
    allFunctions: [
      "parseConfig",
      "decodePayload",
      "buildQuery",
      "measureLatency",
      "timeBlock",
      "tick",
      "helperA",
      "helperB",
      "helperC",
      "helperD",
    ],
    fixtures: [],
  };
}

function makeModel(overrides: Partial<QualifiedModel> = {}): QualifiedModel {
  const id = overrides.id ?? "vendor/model-a";
  return {
    id,
    name: overrides.name ?? "Model A",
    contextTokens: overrides.contextTokens ?? 200_000,
    maxOutputTokens: overrides.maxOutputTokens ?? 64_000,
    inputDollarsPerMillion: overrides.inputDollarsPerMillion ?? 0.5,
    outputDollarsPerMillion: overrides.outputDollarsPerMillion ?? 1.5,
    supportsStructured: overrides.supportsStructured ?? true,
    supportsReasoning: overrides.supportsReasoning ?? true,
    raw: overrides.raw ?? { id },
  };
}

function makePerKeyword(over: Partial<PerKeywordScore> = {}): PerKeywordScore {
  return {
    expected: over.expected ?? [],
    returned: over.returned ?? [],
    truePositives: over.truePositives ?? [],
    falsePositives: over.falsePositives ?? [],
    falseNegatives: over.falseNegatives ?? [],
    precision: over.precision ?? 1,
    recall: over.recall ?? 1,
    f1: over.f1 ?? 1,
    exactMatch: over.exactMatch ?? true,
  };
}

function makeRun(over: Partial<RunResult> = {}): RunResult {
  return {
    modelId: over.modelId ?? "vendor/model-a",
    ok: true,
    kw1: over.kw1 ?? ["parseConfig", "decodePayload"],
    kw2: over.kw2 ?? ["buildQuery"],
    kw3: over.kw3 ?? ["measureLatency", "timeBlock", "tick"],
    inputTokens: over.inputTokens ?? 4321,
    outputTokens: over.outputTokens ?? 210,
    reasoningTokens: over.reasoningTokens ?? 90,
    latencyMs: over.latencyMs ?? 1234.7,
    providerFinishReason: over.providerFinishReason ?? "stop",
    rawResponse: over.rawResponse ?? "{}",
    schemaCompliant: over.schemaCompliant ?? true,
  };
}

function makeScore(over: Partial<ModelScore> = {}): ModelScore {
  return {
    modelId: over.modelId ?? "vendor/model-a",
    pass: over.pass ?? true,
    meanF1: over.meanF1 ?? 1,
    perKeyword: over.perKeyword ?? [makePerKeyword(), makePerKeyword(), makePerKeyword()],
    hallucinated: over.hallucinated ?? [],
  };
}

type Entry = { model: QualifiedModel; outcome: RunOutcome; score: ModelScore | null; isBaseline: boolean };

function makeInput(
  entries: Array<[string, Entry]>,
  over: Partial<Omit<ReportInput, "results">> = {},
): ReportInput {
  return {
    timestamp: over.timestamp ?? "2026-01-02T03:04:05Z",
    truth: over.truth ?? makeTruth(),
    rosterCandidates: over.rosterCandidates ?? [],
    rosterBaselines: over.rosterBaselines ?? [],
    results: new Map<string, Entry>(entries),
  };
}

// ── tests ─────────────────────────────────────────────────────────────

describe("benchmark/report renderers", () => {
  it("renderJson emits the flat ground-truth counts and roster ids with zero results", () => {
    const input = makeInput([], {
      rosterCandidates: [makeModel({ id: "vendor/cand-1" })],
      rosterBaselines: [makeModel({ id: "vendor/base-1" })],
    });
    const parsed = JSON.parse(renderJson(input));
    expect(parsed.timestamp).toBe("2026-01-02T03:04:05Z");
    expect(parsed.keywords).toEqual(["JSON.parse(", "new URLSearchParams", "performance.now()"]);
    expect(parsed.groundTruth).toEqual({
      kw1FunctionCount: 2,
      kw2FunctionCount: 1,
      kw3FunctionCount: 3,
      noiseFunctionCount: 4,
      totalFunctionCount: 10,
    });
    expect(parsed.roster).toEqual({ candidates: ["vendor/cand-1"], baselines: ["vendor/base-1"] });
    expect(parsed.results).toEqual([]);
  });

  it("renderJson maps a passing model to ok=true with per-keyword F1 and computed cost", () => {
    const model = makeModel({ id: "vendor/good", inputDollarsPerMillion: 2, outputDollarsPerMillion: 4 });
    const run = makeRun({ modelId: "vendor/good", inputTokens: 1_000_000, outputTokens: 250_000, reasoningTokens: 250_000 });
    const score = makeScore({
      modelId: "vendor/good",
      pass: true,
      meanF1: 0.8,
      perKeyword: [
        makePerKeyword({ f1: 0.9 }),
        makePerKeyword({ f1: 0.7 }),
        makePerKeyword({ f1: 0.8 }),
      ],
      hallucinated: ["ghostFn"],
    });
    const parsed = JSON.parse(
      renderJson(makeInput([["vendor/good", { model, outcome: run, score, isBaseline: false }]])),
    );
    const r = parsed.results[0];
    expect(r.ok).toBe(true);
    expect(r.modelId).toBe("vendor/good");
    expect(r.pass).toBe(true);
    expect(r.meanF1).toBe(0.8);
    expect(r.kw1F1).toBe(0.9);
    expect(r.kw2F1).toBe(0.7);
    expect(r.kw3F1).toBe(0.8);
    expect(r.hallucinatedNames).toEqual(["ghostFn"]);
    // input: 1M tok @ $2/M = $2 ; output+reasoning: 500k tok @ $4/M = $2 ; total = $4.
    expect(r.actualCost).toBeCloseTo(4, 10);
  });

  it("renderJson maps an error outcome to ok=false carrying error, httpStatus and latency", () => {
    const model = makeModel({ id: "vendor/dead" });
    const err: RunError = {
      modelId: "vendor/dead",
      ok: false,
      error: "429 rate limited",
      httpStatus: 429,
      latencyMs: 88.4,
    };
    const parsed = JSON.parse(
      renderJson(makeInput([["vendor/dead", { model, outcome: err, score: null, isBaseline: true }]])),
    );
    const r = parsed.results[0];
    expect(r.ok).toBe(false);
    expect(r.error).toBe("429 rate limited");
    expect(r.httpStatus).toBe(429);
    expect(r.latencyMs).toBe(88.4);
    expect(r.isBaseline).toBe(true);
    // ok=false branch must NOT leak scoring fields.
    expect(r).not.toHaveProperty("meanF1");
    expect(r).not.toHaveProperty("pass");
  });

  it("renderReport ranks model rows by mean F1 descending with errored rows last", () => {
    const lo = makeModel({ id: "vendor/low" });
    const hi = makeModel({ id: "vendor/high" });
    const bad = makeModel({ id: "vendor/bad" });
    const loScore = makeScore({ modelId: "vendor/low", meanF1: 0.3 });
    const hiScore = makeScore({ modelId: "vendor/high", meanF1: 0.95 });
    const badOutcome: RunError = { modelId: "vendor/bad", ok: false, error: "boom", latencyMs: 12 };
    // Insertion order deliberately low, bad, high to prove the sort, not Map order.
    const md = renderReport(
      makeInput([
        ["vendor/low", { model: lo, outcome: makeRun({ modelId: "vendor/low" }), score: loScore, isBaseline: false }],
        ["vendor/bad", { model: bad, outcome: badOutcome, score: null, isBaseline: false }],
        ["vendor/high", { model: hi, outcome: makeRun({ modelId: "vendor/high" }), score: hiScore, isBaseline: false }],
      ]),
    );
    const idxHigh = md.indexOf("`vendor/high`");
    const idxLow = md.indexOf("`vendor/low`");
    const idxBad = md.indexOf("❌ error");
    expect(idxHigh).toBeGreaterThan(-1);
    expect(idxHigh).toBeLessThan(idxLow); // higher mean-F1 ranked above lower
    expect(idxLow).toBeLessThan(idxBad); // error row (meanF1 -1) sorts last
  });

  it("renderReport formats percentages, dollar cost, token counts and the baseline tag", () => {
    const model = makeModel({ id: "vendor/fmt", inputDollarsPerMillion: 2, outputDollarsPerMillion: 4 });
    const run = makeRun({
      modelId: "vendor/fmt",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      reasoningTokens: 0,
      latencyMs: 999.6,
    });
    const score = makeScore({
      modelId: "vendor/fmt",
      pass: false,
      meanF1: 0.5,
      perKeyword: [makePerKeyword({ f1: 0.5 }), makePerKeyword({ f1: 0.5 }), makePerKeyword({ f1: 0.5 })],
    });
    const md = renderReport(
      makeInput([["vendor/fmt", { model, outcome: run, score, isBaseline: true }]]),
    );
    expect(md).toContain("`vendor/fmt` _(baseline)_");
    expect(md).toContain("❌ FAIL");
    expect(md).toContain("50.0%"); // pct() of 0.5
    // input 1M @ $2/M = $2 ; output 500k @ $4/M = $2 ; total $4.0000
    expect(md).toContain("$4.0000");
    expect(md).toContain("1000000"); // raw input token count, not localized
    expect(md).toContain("1000ms"); // 999.6 rounds to 1000 via toFixed(0)
  });

  it("renderReport prints false-positive, missed, and exact-match per-keyword lines", () => {
    const model = makeModel({ id: "vendor/detail" });
    const score = makeScore({
      modelId: "vendor/detail",
      pass: false,
      meanF1: 0.6,
      perKeyword: [
        // kw1: a false positive
        makePerKeyword({ f1: 0.66, precision: 0.5, recall: 1, exactMatch: false, falsePositives: ["bogusFn"] }),
        // kw2: a miss
        makePerKeyword({ f1: 0.66, precision: 1, recall: 0.5, exactMatch: false, falseNegatives: ["buildQuery"] }),
        // kw3: exact match (2 of 2)
        makePerKeyword({
          f1: 1,
          truePositives: ["measureLatency", "tick"],
          expected: ["measureLatency", "tick"],
        }),
      ],
    });
    const md = renderReport(
      makeInput([["vendor/detail", { model, outcome: makeRun({ modelId: "vendor/detail" }), score, isBaseline: false }]]),
    );
    expect(md).toContain("- false positives: `bogusFn`");
    expect(md).toContain("- missed: `buildQuery`");
    expect(md).toContain("- exact match (2/2)");
  });

  it("renderReport lists hallucinated names only when the model invented some", () => {
    const model = makeModel({ id: "vendor/halluc" });
    const withGhost = makeScore({ modelId: "vendor/halluc", hallucinated: ["notAFunc", "alsoFake"] });
    const mdWith = renderReport(
      makeInput([["vendor/halluc", { model, outcome: makeRun({ modelId: "vendor/halluc" }), score: withGhost, isBaseline: false }]]),
    );
    expect(mdWith).toContain("hallucinated (names not in any fixture): `notAFunc`, `alsoFake`");

    const clean = makeScore({ modelId: "vendor/halluc", hallucinated: [] });
    const mdClean = renderReport(
      makeInput([["vendor/halluc", { model, outcome: makeRun({ modelId: "vendor/halluc" }), score: clean, isBaseline: false }]]),
    );
    expect(mdClean).not.toContain("hallucinated (names not in any fixture)");
  });

  it("renderReport roster table localizes token counts and dashes non-finite baseline prices", () => {
    const candidate = makeModel({
      id: "vendor/cand",
      contextTokens: 200_000,
      maxOutputTokens: 64_000,
      inputDollarsPerMillion: 0.3,
      outputDollarsPerMillion: 0.6,
    });
    const baseline = makeModel({
      id: "vendor/base",
      contextTokens: 1_000_000,
      maxOutputTokens: 128_000,
      inputDollarsPerMillion: Infinity, // unknown pricing → "–"
      outputDollarsPerMillion: Infinity,
    });
    const md = renderReport(makeInput([], { rosterCandidates: [candidate], rosterBaselines: [baseline] }));
    expect(md).toContain("Candidates (1)");
    expect(md).toContain("Baselines (1)");
    // candidate row: finite prices formatted, context localized with separators.
    expect(md).toContain("`vendor/cand` | candidate | 200,000 | 64,000 | $0.30 | $0.60");
    // baseline row: Infinity prices rendered as "–", context still localized.
    expect(md).toContain("`vendor/base` | baseline | 1,000,000 | 128,000 | – | –");
  });
});
