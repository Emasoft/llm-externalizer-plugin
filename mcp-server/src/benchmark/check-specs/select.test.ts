// Tests for the check_against_specs selection gate (P2d). Pure module — no network, no IO.

import { describe, it, expect } from "vitest";

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import { aggregateScores, scoreCase, type SectionVerdict } from "../search-existing/score.js";
import {
  CHECK_SPECS_CRITERIA,
  selectCheckSpecsModel,
  type CheckSpecsCandidate,
} from "./select.js";
import { type CheckSpecsScore } from "./score.js";

// Shaped like the real corpus: 4 violations among 13 files.
const FILES = ["v1", "v2", "v3", "v4", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];
const VIOLATIONS = new Set(["v1", "v2", "v3", "v4"]);

function scoreOf(over: Record<string, SectionVerdict>): CheckSpecsScore {
  const m = new Map<string, SectionVerdict>();
  for (const f of FILES) m.set(f, over[f] ?? "no");
  return aggregateScores([scoreCase("c", FILES, VIOLATIONS, m)]);
}

const PERFECT = scoreOf({ v1: "yes", v2: "yes", v3: "yes", v4: "yes" });
const GOOD = scoreOf({ v1: "yes", v2: "yes", v3: "yes", v4: "yes", c1: "yes" }); // one over-flag
const SILENT = scoreOf({}); // CLEAN to everything → fails the recall floor

function candidate(over: Partial<CheckSpecsCandidate>): CheckSpecsCandidate {
  return {
    modelId: "vendor/x",
    qualified: true,
    inputDollarsPerMillion: 0.1,
    outputDollarsPerMillion: 0.4,
    latencyMs: 1000,
    score: PERFECT,
    ...over,
  };
}

const INCUMBENT = {
  incumbentModelId: "vendor/incumbent",
  incumbentInputDollarsPerMillion: 0.2,
  incumbentOutputDollarsPerMillion: 0.8,
};

describe("selectCheckSpecsModel", () => {
  it("reads its requirements FROM the registry — never a divergent copy", () => {
    // The numbers must live in exactly one place. A second copy here would drift the day
    // the registry's requirements change, and the gate would silently benchmark models the
    // tool cannot actually use.
    expect(CHECK_SPECS_CRITERIA).toBe(TOOL_MODEL_REGISTRY.check_against_specs.requirements);
    expect(CHECK_SPECS_CRITERIA.requireReasoning).toBe(false);
  });

  it("promotes a cheaper, qualified, benchmark-passing candidate", () => {
    const r = selectCheckSpecsModel({
      candidates: [candidate({ modelId: "vendor/cheap", score: PERFECT })],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(true);
    expect(r.recommendedModelId).toBe("vendor/cheap");
  });

  it("NEVER promotes a pricier model, however good its score", () => {
    const r = selectCheckSpecsModel({
      candidates: [
        candidate({
          modelId: "vendor/pricey",
          score: PERFECT,
          inputDollarsPerMillion: 5,
          outputDollarsPerMillion: 20,
        }),
      ],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(false);
    expect(r.recommendedModelId).toBe("vendor/incumbent");
  });

  it("NEVER promotes a model that failed the benchmark, however cheap", () => {
    // The free model that answers CLEAN to everything is the exact temptation the gate
    // exists to refuse: it costs nothing and it finds nothing.
    const r = selectCheckSpecsModel({
      candidates: [
        candidate({
          modelId: "vendor/silent",
          score: SILENT,
          inputDollarsPerMillion: 0,
          outputDollarsPerMillion: 0,
        }),
      ],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(false);
    expect(r.rejected.some((x) => x.modelId === "vendor/silent")).toBe(true);
  });

  it("NEVER promotes a model that fails the tool's requirements", () => {
    const r = selectCheckSpecsModel({
      candidates: [
        candidate({
          modelId: "vendor/unqualified",
          qualified: false,
          disqualifyReason: "no structured outputs",
        }),
      ],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(false);
    expect(r.rejected.some((x) => x.modelId === "vendor/unqualified")).toBe(true);
  });

  it("ranks eligible passers by micro-F1 — the per-FILE verdict is the atom of work", () => {
    const r = selectCheckSpecsModel({
      candidates: [
        candidate({ modelId: "vendor/good", score: GOOD }),
        candidate({ modelId: "vendor/best", score: PERFECT }),
      ],
      ...INCUMBENT,
    });
    expect(r.recommendedModelId).toBe("vendor/best");
    expect(r.eligible[0].modelId).toBe("vendor/best");
    expect(PERFECT.microF1).toBeGreaterThan(GOOD.microF1);
  });

  it("keeps the incumbent when there is no eligible passer at all", () => {
    const r = selectCheckSpecsModel({ candidates: [], ...INCUMBENT });
    expect(r.changed).toBe(false);
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.eligible).toEqual([]);
  });
});
