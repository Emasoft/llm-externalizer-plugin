// Selection-gate tests for the code_task model (P2b). Pure — no LLM, no network.
// The gate is the user's standing same-cost rule made mechanical, so each of the
// three gates gets its own test.

import { describe, it, expect } from "vitest";

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import { aggregateScores, scoreCase, type CodeAuditScore } from "./score.js";
import type { CodeAuditCase } from "./dataset.js";
import { CODE_TASK_CRITERIA, selectCodeTaskModel, type CodeTaskCandidate } from "./select.js";

const UNIVERSE = ["alphaFunc", "bravoFunc", "charlieFunc"];

function defectCase(id: string): CodeAuditCase {
  return {
    id,
    file: "f.ts",
    buggySymbols: ["alphaFunc"],
    defectClass: "x",
    fixCommit: "abc1234",
    originalPath: "mcp-server/src/f.ts",
    line: 1,
    rationale: "r",
    source: "s",
  };
}

function cleanCase(id: string): CodeAuditCase {
  return { ...defectCase(id), buggySymbols: [], fixCommit: "", originalPath: "" };
}

/** A score built by running the REAL scorer — never a hand-typed aggregate. */
function scoreFor(hits: number, misses: number, falseAlarms: number): CodeAuditScore {
  const cases = [
    ...Array.from({ length: hits }, (_, i) =>
      scoreCase(defectCase(`hit-${i}`), UNIVERSE, "DEFECT: alphaFunc — real"),
    ),
    ...Array.from({ length: misses }, (_, i) =>
      scoreCase(defectCase(`miss-${i}`), UNIVERSE, "NO DEFECTS"),
    ),
    ...Array.from({ length: falseAlarms }, (_, i) =>
      scoreCase(cleanCase(`fa-${i}`), UNIVERSE, "DEFECT: bravoFunc — invented"),
    ),
    scoreCase(cleanCase("quiet"), UNIVERSE, "NO DEFECTS"),
  ];
  return aggregateScores(cases);
}

function candidate(over: Partial<CodeTaskCandidate> = {}): CodeTaskCandidate {
  return {
    modelId: "vendor/candidate",
    qualified: true,
    inputDollarsPerMillion: 0.1,
    outputDollarsPerMillion: 0.3,
    latencyMs: 1000,
    score: scoreFor(4, 0, 0), // a strong passer
    ...over,
  };
}

const INCUMBENT = {
  incumbentModelId: "vendor/incumbent",
  incumbentInputDollarsPerMillion: 0.2,
  incumbentOutputDollarsPerMillion: 0.5,
};

describe("CODE_TASK_CRITERIA", () => {
  it("IS the registry descriptor's requirements object — not a divergent copy", () => {
    // Same object identity: the requirement numbers live in registry.ts alone, so
    // a change there can never leave the selector grading on stale criteria.
    expect(CODE_TASK_CRITERIA).toBe(TOOL_MODEL_REGISTRY.code_task.requirements);
  });

  it("code_task is now gated by the code-audit benchmark", () => {
    expect(TOOL_MODEL_REGISTRY.code_task.benchmark).toBe("code-task");
  });
});

describe("selectCodeTaskModel — the three gates", () => {
  it("recommends a cheaper, qualified passer over the incumbent", () => {
    const r = selectCodeTaskModel({
      candidates: [
        candidate({ modelId: "vendor/cheap-good", inputDollarsPerMillion: 0.05, outputDollarsPerMillion: 0.1 }),
        candidate({ modelId: "vendor/incumbent", inputDollarsPerMillion: 0.2, outputDollarsPerMillion: 0.5, score: scoreFor(2, 2, 0) }),
      ],
      ...INCUMBENT,
    });
    expect(r.recommendedModelId).toBe("vendor/cheap-good");
    expect(r.changed).toBe(true);
  });

  it("gate 1 — REQUIREMENTS: an unqualified model is rejected however well it scored", () => {
    const r = selectCodeTaskModel({
      candidates: [
        candidate({ modelId: "vendor/unqualified", qualified: false, disqualifyReason: "no reasoning support" }),
      ],
      ...INCUMBENT,
    });
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.rejected[0].reason).toContain("code-task requirements");
    expect(r.rejected[0].reason).toContain("no reasoning support");
  });

  it("gate 2 — BENCHMARK: a model that misses the defects is rejected", () => {
    const r = selectCodeTaskModel({
      candidates: [candidate({ modelId: "vendor/blind", score: scoreFor(0, 4, 0) })],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(false);
    expect(r.rejected[0].reason).toContain("the code-audit benchmark");
  });

  it("gate 3 — COST: a pricier model is NEVER auto-adopted, even with a perfect score", () => {
    const r = selectCodeTaskModel({
      candidates: [
        candidate({ modelId: "vendor/pricey", inputDollarsPerMillion: 5, outputDollarsPerMillion: 15 }),
      ],
      ...INCUMBENT,
    });
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.rejected[0].reason).toContain("never auto-bump to a pricier model");
  });

  it("ranks eligible passers by macro-F1 (best first), tie-broken by cost", () => {
    const r = selectCodeTaskModel({
      candidates: [
        candidate({ modelId: "vendor/ok", score: scoreFor(3, 1, 0) }),
        candidate({ modelId: "vendor/best", score: scoreFor(4, 0, 0) }),
      ],
      ...INCUMBENT,
    });
    expect(r.eligible.map((c) => c.modelId)).toEqual(["vendor/best", "vendor/ok"]);
    expect(r.recommendedModelId).toBe("vendor/best");
  });

  it("keeps the incumbent when nothing eligible exists — never leaves the tool without a default", () => {
    const r = selectCodeTaskModel({ candidates: [], ...INCUMBENT });
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("Keeping the incumbent default");
  });
});
