// Unit tests for the search_existing_implementations selection gate
// (TRDD-828238b5 A6). Pure, no network. Verifies that the criteria are the SAME
// object as the registry descriptor (single source of truth) and that the gate
// picks winner/incumbent correctly through the shared select-common math.

import { describe, it, expect } from "vitest";

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import type { SearchExistingScore } from "./score.js";
import {
  SEARCH_EXISTING_CRITERIA,
  selectSearchExistingModel,
  type SearchExistingCandidate,
  type SearchExistingSelectionInput,
} from "./select.js";

/**
 * A SearchExistingScore with the given micro-F1 / recall / coverage. The other
 * aggregate fields are filled so passesThresholds reads a coherent object.
 */
function score(microF1: number, microRecall: number, coverage: number): SearchExistingScore {
  return {
    cases: [],
    microPrecision: microF1, // coarse; the gate reads microF1 + recall + coverage
    microRecall,
    microF1,
    macroF1: microF1,
    coverage,
  };
}

function cand(
  over: Partial<SearchExistingCandidate> & { modelId: string },
): SearchExistingCandidate {
  return {
    modelId: over.modelId,
    qualified: over.qualified ?? true,
    disqualifyReason: over.disqualifyReason,
    inputDollarsPerMillion: over.inputDollarsPerMillion ?? 0.04,
    outputDollarsPerMillion: over.outputDollarsPerMillion ?? 0.1,
    latencyMs: over.latencyMs ?? 1000,
    // Default: a clearly-passing score (above all DEFAULT thresholds).
    score: over.score ?? score(0.95, 0.95, 1.0),
  };
}

function input(candidates: SearchExistingCandidate[]): SearchExistingSelectionInput {
  return {
    candidates,
    incumbentModelId: "vendor/incumbent",
    incumbentInputDollarsPerMillion: 0.04,
    incumbentOutputDollarsPerMillion: 0.1,
  };
}

describe("SEARCH_EXISTING_CRITERIA", () => {
  it("is the SAME object as the registry descriptor's requirements (single source of truth)", () => {
    expect(SEARCH_EXISTING_CRITERIA).toBe(
      TOOL_MODEL_REGISTRY.search_existing_implementations.requirements,
    );
    // Duplicate-match needs reasoning + 128K context.
    expect(SEARCH_EXISTING_CRITERIA.requireReasoning).toBe(true);
    expect(SEARCH_EXISTING_CRITERIA.minContextTokens).toBe(128_000);
  });
});

describe("selectSearchExistingModel", () => {
  it("keeps the incumbent when it is the only eligible passer", () => {
    const r = selectSearchExistingModel(input([cand({ modelId: "vendor/incumbent" })]));
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.eligible).toHaveLength(1);
  });

  it("picks a same-cost passer with a higher micro-F1 over the incumbent", () => {
    const r = selectSearchExistingModel(
      input([
        cand({ modelId: "vendor/incumbent", score: score(0.88, 0.9, 1.0) }),
        cand({ modelId: "vendor/better", score: score(0.96, 0.96, 1.0) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/better");
    expect(r.changed).toBe(true);
  });

  it("rejects a model that fails the benchmark thresholds (records the recall failure)", () => {
    const r = selectSearchExistingModel(
      input([
        cand({ modelId: "vendor/incumbent", score: score(0.9, 0.9, 1.0) }),
        // recall 0.5 < 0.85 floor → fails, even though it is cheap.
        cand({ modelId: "vendor/lowrecall", score: score(0.6, 0.5, 1.0) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    const rej = r.rejected.find((x) => x.modelId === "vendor/lowrecall")?.reason;
    expect(rej).toContain("the search-existing benchmark");
    expect(rej).toMatch(/recall/);
  });

  it("NEVER auto-bumps to a pricier model even with a higher micro-F1", () => {
    const r = selectSearchExistingModel(
      input([
        cand({ modelId: "vendor/incumbent", score: score(0.9, 0.9, 1.0) }),
        cand({ modelId: "vendor/pricey", outputDollarsPerMillion: 0.5, score: score(0.99, 0.99, 1.0) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.rejected.find((x) => x.modelId === "vendor/pricey")?.reason).toMatch(/pricier/);
  });

  it("rejects an unqualified model with the search-existing requirements label", () => {
    const r = selectSearchExistingModel(
      input([
        cand({ modelId: "vendor/incumbent" }),
        cand({ modelId: "vendor/noreason", qualified: false, disqualifyReason: "no reasoning support", score: score(0.99, 0.99, 1.0) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    const rej = r.rejected.find((x) => x.modelId === "vendor/noreason")?.reason;
    expect(rej).toContain("search-existing requirements");
    expect(rej).toContain("no reasoning support");
  });

  it("accepts a strictly-cheaper passer and reports the change", () => {
    const r = selectSearchExistingModel(
      input([
        cand({ modelId: "vendor/incumbent", score: score(0.9, 0.9, 1.0) }),
        cand({ modelId: "vendor/cheap", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, score: score(0.92, 0.92, 1.0) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/cheap");
    expect(r.changed).toBe(true);
    expect(r.reason).toContain("the search-existing benchmark");
  });
});
