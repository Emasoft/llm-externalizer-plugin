// Unit tests for the DETERMINISTIC code-audit scorer (P2b). Pure — no LLM, no
// network, no judge. Every assertion here is the contract the paid sweep relies
// on: if the extractor or the confusion math is wrong, every model's score is
// wrong and the money is wasted.

import { describe, it, expect } from "vitest";

import type { CodeAuditCase } from "./dataset.js";
import {
  DEFAULT_CODE_AUDIT_THRESHOLDS,
  aggregateScores,
  extractAccusedSymbols,
  passesThresholds,
  scoreCase,
} from "./score.js";

const UNIVERSE = ["parseFileGroups", "splitPerFileSections", "hasNamedGroups", "isPathSuffix"];

function defectCase(over: Partial<CodeAuditCase> = {}): CodeAuditCase {
  return {
    id: "case-1",
    file: "grouping.ts",
    buggySymbols: ["parseFileGroups"],
    defectClass: "input-order loss",
    fixCommit: "c7eac50",
    originalPath: "mcp-server/src/grouping.ts",
    line: 63,
    rationale: "r",
    source: "s",
    ...over,
  };
}

function cleanCase(over: Partial<CodeAuditCase> = {}): CodeAuditCase {
  return defectCase({
    id: "clean-1",
    buggySymbols: [],
    defectClass: "none",
    fixCommit: "",
    originalPath: "",
    line: 0,
    ...over,
  });
}

describe("extractAccusedSymbols — ANCHORED mode", () => {
  it("reads the DEFECT: anchor and ignores prose elsewhere in the report", () => {
    const report = [
      "I reviewed the file thoroughly.",
      "DEFECT: parseFileGroups — the ungrouped files are flushed only at the end.",
      "",
      "I also looked at splitPerFileSections and hasNamedGroups but they are fine.",
    ].join("\n");
    const got = extractAccusedSymbols(report, UNIVERSE);
    // THE point of the anchor: only anchored lines count, so the chatty
    // paragraph naming two other symbols cannot manufacture false positives.
    expect(got.mode).toBe("anchored");
    expect(got.accused).toEqual(["parseFileGroups"]);
  });

  it("tolerates the decorations models add (bullets, bold, backticks, headings)", () => {
    const report = [
      "- **DEFECT:** `parseFileGroups` - order is lost",
      "## DEFECT: splitPerFileSections",
      '3. DEFECT: "isPathSuffix" — ambiguous suffix match',
    ].join("\n");
    const got = extractAccusedSymbols(report, UNIVERSE);
    expect(got.accused).toEqual(["isPathSuffix", "parseFileGroups", "splitPerFileSections"]);
  });

  it("records an anchored name that does not exist as a HALLUCINATION, not a false positive", () => {
    const report = "DEFECT: parseNonExistentThing — invented\nDEFECT: parseFileGroups — real";
    const got = extractAccusedSymbols(report, UNIVERSE);
    expect(got.accused).toEqual(["parseFileGroups"]);
    expect(got.hallucinated).toEqual(["parseNonExistentThing"]);
    // A name that is not in the file cannot be a false positive AGAINST a symbol
    // that does not exist — it is tracked separately (mirrors ModelScore.hallucinated).
  });

  it("'NO DEFECTS' accuses nothing", () => {
    const got = extractAccusedSymbols("NO DEFECTS", UNIVERSE);
    expect(got.accused).toEqual([]);
    expect(got.mode).toBe("empty");
  });
});

describe("extractAccusedSymbols — FREETEXT fallback", () => {
  it("accuses a symbol named in a finding when the model ignored the anchor format", () => {
    // A model that writes prose still FOUND the bug. Scoring it 0 would measure
    // instruction-following, not code understanding.
    const report = "The bug is in `parseFileGroups`: ungrouped files are re-emitted after the group.";
    const got = extractAccusedSymbols(report, UNIVERSE);
    expect(got.mode).toBe("freetext");
    expect(got.accused).toEqual(["parseFileGroups"]);
  });

  it("does NOT accuse a symbol on a line that CLEARS it", () => {
    const report = [
      "parseFileGroups has a real bug: input order is lost.",
      "splitPerFileSections looks correct.",
      "hasNamedGroups — no issues found.",
      "isPathSuffix is fine.",
    ].join("\n");
    const got = extractAccusedSymbols(report, UNIVERSE);
    expect(got.accused).toEqual(["parseFileGroups"]);
  });

  it("matches on identifier boundaries, never inside a longer identifier", () => {
    // `myParseFileGroupsWrapper` must NOT count as naming `parseFileGroups`.
    const report = "The helper myparseFileGroupsWrapper is unrelated and untouched here.";
    const got = extractAccusedSymbols(report, UNIVERSE);
    expect(got.accused).toEqual([]);
  });

  it("is case-sensitive (a prose word is not an identifier)", () => {
    const report = "Nothing to report about parsefilegroups in lowercase prose.";
    expect(extractAccusedSymbols(report, UNIVERSE).accused).toEqual([]);
  });

  it("does NOT accuse symbols merely QUOTED inside a fenced code block", () => {
    // A model that quotes the offending code to explain itself would otherwise be
    // punished for every innocent symbol its quote happens to contain — handing a
    // false positive to exactly the models that explain themselves best.
    const report = [
      "The bug is in parseFileGroups. Here is the offending code:",
      "```ts",
      "const ok = hasNamedGroups(groups) && isPathSuffix(a, b);",
      "splitPerFileSections(content, paths);",
      "```",
      "That is all.",
    ].join("\n");
    const got = extractAccusedSymbols(report, UNIVERSE);
    expect(got.mode).toBe("freetext");
    expect(got.accused).toEqual(["parseFileGroups"]);
  });
});

describe("scoreCase", () => {
  it("perfect localization on a defect case → precision 1, recall 1, exactMatch", () => {
    const s = scoreCase(defectCase(), UNIVERSE, "DEFECT: parseFileGroups — order lost");
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.exactMatch).toBe(true);
  });

  it("a missed defect is a false negative (recall 0)", () => {
    const s = scoreCase(defectCase(), UNIVERSE, "NO DEFECTS");
    expect(s.falseNegatives).toEqual(["parseFileGroups"]);
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
  });

  it("half of a two-symbol truth → recall 0.5, precision 1", () => {
    const c = defectCase({ buggySymbols: ["parseFileGroups", "splitPerFileSections"] });
    const s = scoreCase(c, UNIVERSE, "DEFECT: parseFileGroups — order lost");
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(0.5);
    expect(s.f1).toBeCloseTo(2 / 3, 5);
    expect(s.exactMatch).toBe(false);
  });

  it("silence on a CLEAN case is the correct answer → F1 1", () => {
    const s = scoreCase(cleanCase(), UNIVERSE, "NO DEFECTS");
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
    expect(s.exactMatch).toBe(true);
  });

  it("inventing a defect on a CLEAN case zeroes that case (precision 0)", () => {
    // This is the whole job of the clean fixtures: hallucination resistance.
    const s = scoreCase(cleanCase(), UNIVERSE, "DEFECT: hasNamedGroups — invented concern");
    expect(s.falsePositives).toEqual(["hasNamedGroups"]);
    expect(s.precision).toBe(0);
    expect(s.f1).toBe(0);
  });

  it("a pipeline FAILURE is scored with an empty accused set, not dropped", () => {
    // Dropping it would let a model that errored on the hard cases pass on the
    // strength of the easy ones.
    const s = scoreCase(defectCase(), UNIVERSE, "", /* failed */ true);
    expect(s.failed).toBe(true);
    expect(s.returned).toEqual([]);
    expect(s.recall).toBe(0);
  });
});

describe("aggregateScores + passesThresholds", () => {
  const universe = UNIVERSE;

  it("micro-pools the confusion counts and macro-averages the per-case F1", () => {
    const cases = [
      scoreCase(defectCase({ id: "a" }), universe, "DEFECT: parseFileGroups — x"),
      scoreCase(cleanCase({ id: "b" }), universe, "NO DEFECTS"),
      scoreCase(defectCase({ id: "c" }), universe, "NO DEFECTS"), // missed
    ];
    const agg = aggregateScores(cases);
    expect(agg.microRecall).toBe(0.5); // 1 TP / (1 TP + 1 FN)
    expect(agg.microPrecision).toBe(1); // 1 TP / (1 TP + 0 FP)
    expect(agg.macroF1).toBeCloseTo((1 + 1 + 0) / 3, 5);
    expect(agg.exactMatches).toBe(2);
  });

  it("a model that finds everything and invents nothing PASSES", () => {
    const cases = [
      scoreCase(defectCase({ id: "a" }), universe, "DEFECT: parseFileGroups — x"),
      scoreCase(defectCase({ id: "b" }), universe, "DEFECT: parseFileGroups — x"),
      scoreCase(cleanCase({ id: "c" }), universe, "NO DEFECTS"),
    ];
    expect(passesThresholds(aggregateScores(cases)).pass).toBe(true);
  });

  it("a model that says NO DEFECTS to EVERYTHING cannot pass — the recall floor", () => {
    // The gameable strategy: score 1 on every clean case by staying silent. The
    // explicit micro-recall floor is what makes it structurally impossible.
    const cases = [
      scoreCase(defectCase({ id: "a" }), universe, "NO DEFECTS"),
      scoreCase(defectCase({ id: "b" }), universe, "NO DEFECTS"),
      scoreCase(cleanCase({ id: "c" }), universe, "NO DEFECTS"),
      scoreCase(cleanCase({ id: "d" }), universe, "NO DEFECTS"),
      scoreCase(cleanCase({ id: "e" }), universe, "NO DEFECTS"),
    ];
    const agg = aggregateScores(cases);
    expect(agg.microRecall).toBe(0);
    const thr = passesThresholds(agg);
    expect(thr.pass).toBe(false);
    expect(thr.failures.join(" ")).toMatch(/micro-recall/);
  });

  it("a model that accuses EVERY symbol of EVERYTHING cannot pass — precision collapses", () => {
    const shotgun = universe.map((s) => `DEFECT: ${s} — maybe`).join("\n");
    const cases = [
      scoreCase(defectCase({ id: "a" }), universe, shotgun),
      scoreCase(cleanCase({ id: "b" }), universe, shotgun),
      scoreCase(cleanCase({ id: "c" }), universe, shotgun),
    ];
    expect(passesThresholds(aggregateScores(cases)).pass).toBe(false);
  });

  it("too many pipeline failures make the run inadmissible, not merely low-scoring", () => {
    const cases = [
      scoreCase(defectCase({ id: "a" }), universe, "DEFECT: parseFileGroups — x"),
      scoreCase(defectCase({ id: "b" }), universe, "DEFECT: parseFileGroups — x"),
      scoreCase(defectCase({ id: "c" }), universe, "", true),
      scoreCase(defectCase({ id: "d" }), universe, "", true),
    ];
    const thr = passesThresholds(aggregateScores(cases));
    expect(thr.pass).toBe(false);
    expect(thr.failures.join(" ")).toMatch(/produced no report/);
  });

  it("the thresholds are the ones the design spec calibrated", () => {
    // Pinned so a future edit to the bar is a deliberate, reviewed act.
    expect(DEFAULT_CODE_AUDIT_THRESHOLDS.minMacroF1).toBe(0.5);
    expect(DEFAULT_CODE_AUDIT_THRESHOLDS.minMicroRecall).toBe(0.5);
    expect(DEFAULT_CODE_AUDIT_THRESHOLDS.maxFailedCases).toBe(1);
  });
});
