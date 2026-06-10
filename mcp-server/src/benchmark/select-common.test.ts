// Unit tests for the shared same-or-cheaper selection gate (TRDD-828238b5 A6).
// Pure, no network. Verifies the three gates (requirements / benchmark pass /
// never-pricier), the best-of-equivalent-cost ranking, the incumbent-kept
// fallback, the epsilon tolerance, and that the rejection/recommendation
// messages use the parameterized labels.

import { describe, it, expect } from "vitest";

import {
  COST_EPSILON,
  notPricier,
  selectSameOrCheaper,
  type GenericCandidate,
  type GenericSelectionInput,
} from "./select-common.js";

function cand(
  over: Partial<GenericCandidate> & { modelId: string },
): GenericCandidate {
  return {
    modelId: over.modelId,
    qualified: over.qualified ?? true,
    disqualifyReason: over.disqualifyReason,
    inputDollarsPerMillion: over.inputDollarsPerMillion ?? 0.04,
    outputDollarsPerMillion: over.outputDollarsPerMillion ?? 0.1,
    latencyMs: over.latencyMs ?? 1000,
    benchmarkPass: over.benchmarkPass ?? true,
    benchmarkScore: over.benchmarkScore ?? 0.8,
    benchmarkFailReasons: over.benchmarkFailReasons ?? [],
  };
}

// Incumbent @ $0.04 in / $0.10 out.
function input(candidates: GenericCandidate[]): GenericSelectionInput {
  return {
    candidates,
    incumbentModelId: "vendor/incumbent",
    incumbentInputDollarsPerMillion: 0.04,
    incumbentOutputDollarsPerMillion: 0.1,
    requirementsLabel: "the test requirements",
    benchmarkLabel: "the test benchmark",
  };
}

describe("notPricier", () => {
  it("treats equal prices as not-pricier (same-cost allowed)", () => {
    expect(notPricier(cand({ modelId: "a", inputDollarsPerMillion: 0.04, outputDollarsPerMillion: 0.1 }), 0.04, 0.1)).toBe(true);
  });

  it("rejects a candidate pricier on either axis", () => {
    expect(notPricier(cand({ modelId: "a", inputDollarsPerMillion: 0.05, outputDollarsPerMillion: 0.1 }), 0.04, 0.1)).toBe(false);
    expect(notPricier(cand({ modelId: "a", inputDollarsPerMillion: 0.04, outputDollarsPerMillion: 0.2 }), 0.04, 0.1)).toBe(false);
  });

  it("tolerates a sub-epsilon overshoot (float pricing noise)", () => {
    expect(
      notPricier(
        cand({ modelId: "a", inputDollarsPerMillion: 0.04 + COST_EPSILON / 2, outputDollarsPerMillion: 0.1 }),
        0.04,
        0.1,
      ),
    ).toBe(true);
  });
});

describe("selectSameOrCheaper", () => {
  it("keeps the incumbent when it is the only eligible passer", () => {
    const r = selectSameOrCheaper(input([cand({ modelId: "vendor/incumbent" })]));
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.eligible).toHaveLength(1);
  });

  it("picks a same-cost passer with a higher score over the incumbent", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.8 }),
        cand({ modelId: "vendor/better", benchmarkScore: 0.92 }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/better");
    expect(r.changed).toBe(true);
  });

  it("NEVER auto-bumps to a pricier model even if it scores higher", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.8 }),
        cand({ modelId: "vendor/pricey", outputDollarsPerMillion: 0.5, benchmarkScore: 0.99 }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.rejected.find((x) => x.modelId === "vendor/pricey")?.reason).toMatch(/pricier/);
  });

  it("accepts a strictly-cheaper higher-scoring model", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.8 }),
        cand({ modelId: "vendor/cheap", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, benchmarkScore: 0.9 }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/cheap");
    expect(r.changed).toBe(true);
  });

  it("rejects a model that failed the benchmark and records the failReasons + label", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.8 }),
        cand({ modelId: "vendor/fail", benchmarkPass: false, benchmarkScore: 0.95, benchmarkFailReasons: ["recall too low"] }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    const rej = r.rejected.find((x) => x.modelId === "vendor/fail")?.reason;
    expect(rej).toContain("the test benchmark");
    expect(rej).toContain("recall too low");
  });

  it("rejects a model that does not meet the requirements (uses the label + disqualifyReason)", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.8 }),
        cand({ modelId: "vendor/nostruct", qualified: false, disqualifyReason: "no structured output", benchmarkScore: 0.99 }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    const rej = r.rejected.find((x) => x.modelId === "vendor/nostruct")?.reason;
    expect(rej).toContain("the test requirements");
    expect(rej).toContain("no structured output");
  });

  it("breaks score ties by lower total cost, then latency", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "a", inputDollarsPerMillion: 0.04, outputDollarsPerMillion: 0.1, latencyMs: 1000, benchmarkScore: 0.9 }),
        cand({ modelId: "b", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, latencyMs: 5000, benchmarkScore: 0.9 }), // same score, cheaper
        cand({ modelId: "c", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, latencyMs: 500, benchmarkScore: 0.9 }), // same score+cost, faster
      ]),
    );
    expect(r.eligible.map((e) => e.modelId)).toEqual(["c", "b", "a"]);
    expect(r.recommendedModelId).toBe("c");
  });

  it("keeps the incumbent when every alternative fails some gate", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.7 }),
        cand({ modelId: "x", benchmarkPass: false, benchmarkScore: 0.9, benchmarkFailReasons: ["score too low"] }),
        cand({ modelId: "y", inputDollarsPerMillion: 2.0, outputDollarsPerMillion: 2.0, benchmarkScore: 0.99 }),
        cand({ modelId: "z", qualified: false, disqualifyReason: "no reasoning", benchmarkScore: 0.99 }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.eligible).toHaveLength(1);
  });

  it("accepts a sub-epsilon-pricier same-score model (epsilon tolerance end-to-end)", () => {
    const r = selectSameOrCheaper(
      input([
        cand({ modelId: "vendor/incumbent", benchmarkScore: 0.8 }),
        // a hair pricier on input due to float noise, but higher score → eligible
        cand({ modelId: "vendor/noisy", inputDollarsPerMillion: 0.04 + COST_EPSILON / 2, benchmarkScore: 0.9 }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/noisy");
    expect(r.changed).toBe(true);
  });
});
