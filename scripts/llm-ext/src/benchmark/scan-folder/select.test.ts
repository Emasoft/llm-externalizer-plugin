// Tests for the scan_folder selection gate (P2c). Pure module — no network, no IO.

import { describe, it, expect } from "vitest";

import { aggregateScores, scoreCase, type SectionVerdict } from "../search-existing/score.js";
import { SCAN_FOLDER_CRITERIA, selectScanFolderModel, type ScanFolderCandidate } from "./select.js";
import { type ScanFolderScore } from "./score.js";

const FILES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
const EXPECTED = new Set(["a.ts", "b.ts"]);

/** Build a real score by running the REAL scorer over a synthetic verdict set. */
function scoreOf(v: Record<string, SectionVerdict>): ScanFolderScore {
  return aggregateScores([scoreCase("q", FILES, EXPECTED, new Map(Object.entries(v)))]);
}

const PERFECT = scoreOf({ "a.ts": "yes", "b.ts": "yes", "c.ts": "no", "d.ts": "no", "e.ts": "no" });
const GOOD = scoreOf({ "a.ts": "yes", "b.ts": "yes", "c.ts": "no", "d.ts": "no", "e.ts": "yes" });
const SILENT = scoreOf({ "a.ts": "no", "b.ts": "no", "c.ts": "no", "d.ts": "no", "e.ts": "no" });

function candidate(over: Partial<ScanFolderCandidate>): ScanFolderCandidate {
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

describe("selectScanFolderModel", () => {
  it("reads its requirements FROM the registry — never a divergent copy", () => {
    // The numbers must live in exactly one place. A second copy here would drift the
    // day the registry's requirements change, and the gate would silently benchmark
    // models the tool cannot actually use.
    expect(SCAN_FOLDER_CRITERIA.minContextTokens).toBe(128_000);
    expect(SCAN_FOLDER_CRITERIA.requireReasoning).toBe(false);
  });

  it("promotes a cheaper, qualified, benchmark-passing candidate", () => {
    const r = selectScanFolderModel({
      candidates: [candidate({ modelId: "vendor/cheap", score: PERFECT })],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(true);
    expect(r.recommendedModelId).toBe("vendor/cheap");
  });

  it("NEVER promotes a pricier model, however good its score", () => {
    const r = selectScanFolderModel({
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
    const r = selectScanFolderModel({
      candidates: [
        candidate({
          modelId: "vendor/silent",
          score: SILENT, // says NO_MATCH to everything → fails the recall floor
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
    const r = selectScanFolderModel({
      candidates: [
        candidate({
          modelId: "vendor/tiny-context",
          qualified: false,
          disqualifyReason: "context below 128K",
        }),
      ],
      ...INCUMBENT,
    });
    expect(r.changed).toBe(false);
    expect(r.rejected.some((x) => x.modelId === "vendor/tiny-context")).toBe(true);
  });

  it("ranks eligible passers by micro-F1 — the per-FILE decision is the atom of work", () => {
    // Micro, not macro: every case scans the same ten files, and a mass search is
    // judged on file decisions, not on queries. Macro would let a 2-positive query
    // count as much as a 6-positive one.
    const r = selectScanFolderModel({
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
    const r = selectScanFolderModel({ candidates: [], ...INCUMBENT });
    expect(r.changed).toBe(false);
    expect(r.recommendedModelId).toBe("vendor/incumbent");
    expect(r.eligible).toEqual([]);
  });
});
