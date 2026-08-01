// Unit tests for the security-triage selection gate — pure, no network.
// Verifies the three gates (requirements / benchmark pass / never-pricier) and
// the best-of-equivalent-cost ranking, plus the incumbent-kept fallback.

import { describe, it, expect } from "vitest";

import type { TriageScore } from "./score.js";
import {
  selectSecurityTriageModel,
  SECURITY_TRIAGE_CRITERIA,
  type CandidateAssessment,
  type SelectionInput,
} from "./select.js";

function triage(modelId: string, pass: boolean, score: number, failReasons: string[] = []): TriageScore {
  return {
    modelId,
    total: 30,
    scoredCount: 30,
    erroredCount: 0,
    errorRate: 0,
    correctCount: 0,
    correctRate: 0,
    overFlagCount: 0,
    overFlagRate: 0,
    underFlagCount: 0,
    underFlagRate: 0,
    appropriatelyUncertainCount: 0,
    criticalCount: 0,
    criticalUnderFlags: 0,
    score,
    inconclusive: false,
    pass,
    failReasons,
    perCase: [],
  };
}

function cand(over: Partial<CandidateAssessment> & { modelId: string }): CandidateAssessment {
  return {
    modelId: over.modelId,
    qualified: over.qualified ?? true,
    disqualifyReason: over.disqualifyReason,
    inputDollarsPerMillion: over.inputDollarsPerMillion ?? 0.04,
    outputDollarsPerMillion: over.outputDollarsPerMillion ?? 0.10,
    latencyMs: over.latencyMs ?? 1000,
    triage: over.triage ?? triage(over.modelId, true, 0.8),
  };
}

// Incumbent: qwen-2.5-7b @ $0.04 in / $0.10 out.
function input(candidates: CandidateAssessment[]): SelectionInput {
  return {
    candidates,
    incumbentModelId: "qwen/qwen-2.5-7b-instruct",
    incumbentInputDollarsPerMillion: 0.04,
    incumbentOutputDollarsPerMillion: 0.10,
  };
}

describe("selectSecurityTriageModel", () => {
  it("keeps the incumbent when it is the only eligible passer", () => {
    const r = selectSecurityTriageModel(
      input([cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.8) })]),
    );
    expect(r.recommendedModelId).toBe("qwen/qwen-2.5-7b-instruct");
    expect(r.changed).toBe(false);
    expect(r.eligible).toHaveLength(1);
  });

  it("picks a same-cost passer with a higher score over the incumbent", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.80) }),
        cand({ modelId: "vendor/better", inputDollarsPerMillion: 0.04, outputDollarsPerMillion: 0.10, triage: triage("vendor/better", true, 0.92) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/better");
    expect(r.changed).toBe(true);
  });

  it("NEVER auto-bumps to a pricier model even if it scores higher", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.80) }),
        // higher score but pricier on output → must be rejected
        cand({ modelId: "vendor/pricey", inputDollarsPerMillion: 0.04, outputDollarsPerMillion: 0.50, triage: triage("vendor/pricey", true, 0.99) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("qwen/qwen-2.5-7b-instruct");
    expect(r.changed).toBe(false);
    expect(r.rejected.find((x) => x.modelId === "vendor/pricey")?.reason).toMatch(/pricier/);
  });

  it("accepts a strictly-cheaper higher-scoring model", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.80) }),
        cand({ modelId: "vendor/cheap", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, triage: triage("vendor/cheap", true, 0.90) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("vendor/cheap");
    expect(r.changed).toBe(true);
  });

  it("rejects a model that failed the benchmark (records the failReasons)", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.80) }),
        cand({ modelId: "vendor/underflagger", triage: triage("vendor/underflagger", false, 0.95, ["1 critical case(s) under-flagged (mandatory-zero floor): pt-dynamic-tainted"]) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("qwen/qwen-2.5-7b-instruct");
    expect(r.rejected.find((x) => x.modelId === "vendor/underflagger")?.reason).toMatch(/under-flagged/);
  });

  it("rejects a model that does not meet the requirements", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.80) }),
        cand({ modelId: "vendor/nostruct", qualified: false, disqualifyReason: "no structured output", triage: triage("vendor/nostruct", true, 0.99) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("qwen/qwen-2.5-7b-instruct");
    expect(r.rejected.find((x) => x.modelId === "vendor/nostruct")?.reason).toMatch(/requirements/);
  });

  it("breaks score ties by lower total cost, then latency", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "a", inputDollarsPerMillion: 0.04, outputDollarsPerMillion: 0.10, latencyMs: 1000, triage: triage("a", true, 0.9) }),
        cand({ modelId: "b", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, latencyMs: 5000, triage: triage("b", true, 0.9) }), // same score, cheaper
        cand({ modelId: "c", inputDollarsPerMillion: 0.02, outputDollarsPerMillion: 0.05, latencyMs: 500, triage: triage("c", true, 0.9) }), // same score+cost, faster
      ]),
    );
    expect(r.eligible.map((e) => e.modelId)).toEqual(["c", "b", "a"]);
    expect(r.recommendedModelId).toBe("c");
  });

  it("keeps the incumbent when every alternative fails some gate", () => {
    const r = selectSecurityTriageModel(
      input([
        cand({ modelId: "qwen/qwen-2.5-7b-instruct", triage: triage("qwen", true, 0.7) }),
        cand({ modelId: "x", triage: triage("x", false, 0.9, ["score too low"]) }),
        cand({ modelId: "y", inputDollarsPerMillion: 2.0, outputDollarsPerMillion: 2.0, triage: triage("y", true, 0.99) }),
      ]),
    );
    expect(r.recommendedModelId).toBe("qwen/qwen-2.5-7b-instruct");
    expect(r.changed).toBe(false);
    expect(r.eligible).toHaveLength(1);
  });

  it("exposes per-tool requirements that do NOT demand reasoning or 128K context", () => {
    expect(SECURITY_TRIAGE_CRITERIA.requireReasoning).toBe(false);
    expect(SECURITY_TRIAGE_CRITERIA.requireStructuredOutputs).toBe(true);
    expect(SECURITY_TRIAGE_CRITERIA.minContextTokens).toBeLessThanOrEqual(32_000);
    expect(SECURITY_TRIAGE_CRITERIA.maxInputDollarsPerMillion).toBe(1.0);
  });
});
