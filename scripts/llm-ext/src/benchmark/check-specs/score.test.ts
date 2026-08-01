// Tests for the check_against_specs (SPEC ADHERENCE) deterministic scorer — P2d.
//
// Pure. No network, no LLM, no fixtures needed: this is string math and set math.

import { describe, it, expect } from "vitest";

import { aggregateScores, scoreCase, type SectionVerdict } from "../search-existing/score.js";
import {
  DEFAULT_CHECK_SPECS_THRESHOLDS,
  NAIVE_STRATEGIES,
  accuracyOf,
  parseSpecVerdict,
  passesThresholds,
  type CheckSpecsScore,
} from "./score.js";

describe("parseSpecVerdict", () => {
  it("reads the VIOLATION anchor and keeps the cited rule", () => {
    const p = parseSpecVerdict("VIOLATION: R2 — the live suite has no LIVE_TESTS gate\n\nDetails…");
    expect(p.verdict).toBe("yes");
    expect(p.citedRule).toBe("R2 — the live suite has no LIVE_TESTS gate");
  });

  it("reads the CLEAN anchor the tool's own system prompt mandates", () => {
    const p = parseSpecVerdict("CLEAN — no spec violations found.");
    expect(p.verdict).toBe("no");
    expect(p.citedRule).toBe("");
  });

  it("accepts a bare CLEAN — a stated verdict is a stated verdict, not a formatting exam", () => {
    expect(parseSpecVerdict("CLEAN.").verdict).toBe("no");
    expect(parseSpecVerdict("**CLEAN** — nothing to report").verdict).toBe("no");
  });

  it("tolerates the decorations models add (bold, bullets, headings, numbering)", () => {
    for (const line of [
      "**VIOLATION:** R1",
      "- VIOLATION: R1",
      "## VIOLATION: R1",
      "1. VIOLATION — R1",
      "violation: r1",
    ]) {
      expect(parseSpecVerdict(line).verdict, line).toBe("yes");
    }
  });

  it("does NOT read a VIOLATION out of a CLEAN line that merely says 'no violations'", () => {
    // "CLEAN — no spec violations found." contains the substring 'violation'. A scorer
    // that matched it anywhere in the line would invert every clean verdict in the
    // corpus. Both anchors are line-START anchored, which is what makes this safe —
    // asserted rather than assumed, because a future tolerance tweak could break it.
    const p = parseSpecVerdict("CLEAN — no spec violations found.");
    expect(p.verdict).toBe("no");
  });

  it("does NOT read a CLEAN out of a VIOLATION line whose prose says 'not clean'", () => {
    const p = parseSpecVerdict("VIOLATION: R1 — this file is not clean");
    expect(p.verdict).toBe("yes");
  });

  it("takes the FIRST anchored line and lets later musing stand", () => {
    // The instructions say the first line IS the verdict. A model that later wonders
    // aloud has not changed its answer, and letting line 9 override line 1 would be the
    // scorer inventing an interpretation.
    const report = [
      "CLEAN — no spec violations found.",
      "",
      "Although one could argue the helper is borderline; VIOLATION: R1 might apply.",
    ].join("\n");
    expect(parseSpecVerdict(report).verdict).toBe("no");
  });

  it("finds a verdict stated after a preamble", () => {
    // Models open with a preamble, and the tool's own system prompt mandates the CLEAN
    // sentence without saying where to put it. A verdict on line 3 is still a verdict.
    const report = ["I reviewed the file against the specification.", "", "CLEAN"].join("\n");
    expect(parseSpecVerdict(report).verdict).toBe("no");
  });

  it("ignores verdict-looking lines inside fenced code — the audited files are TEST files", () => {
    // A thorough auditor QUOTES the code it is judging, and the corpus is full of test
    // files whose assertions contain strings. A quotation must never be read as an answer.
    const report = [
      "Here is the relevant code:",
      "```ts",
      'VIOLATION: expect(cfg).toBe("x")',
      "```",
      "CLEAN — no spec violations found.",
    ].join("\n");
    expect(parseSpecVerdict(report).verdict).toBe("no");
  });

  it("is UNPARSEABLE when the model states no verdict — never a guess", () => {
    // No free-text fallback. Guessing a verdict out of prose that refused to state one
    // means interpreting its meaning, which is a judge, and this benchmark has none.
    // The file is UNSCORED: it costs coverage, and recall if it really was a violation.
    const p = parseSpecVerdict("The file looks broadly consistent with the specification.");
    expect(p.verdict).toBe("unparseable");
  });

  it("a VIOLATION with no cited rule is still a VIOLATION — the verdict is what is graded", () => {
    expect(parseSpecVerdict("VIOLATION").verdict).toBe("yes");
    expect(parseSpecVerdict("VIOLATION").citedRule).toBe("");
  });
});

// ── The gate, and its calibration against THIS corpus's 4 / 9 split ─────────

const FILES = ["v1", "v2", "v3", "v4", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];
const VIOLATIONS = new Set(["v1", "v2", "v3", "v4"]);

/** Run the REAL scorer over a synthetic verdict map shaped like the real corpus. */
function scoreOf(v: Record<string, SectionVerdict>): CheckSpecsScore {
  return aggregateScores([scoreCase("c", FILES, VIOLATIONS, new Map(Object.entries(v)))]);
}

/** Every file gets `dflt`, with `over` applied on top. */
function verdicts(
  dflt: SectionVerdict,
  over: Record<string, SectionVerdict> = {},
): CheckSpecsScore {
  const m: Record<string, SectionVerdict> = {};
  for (const f of FILES) m[f] = over[f] ?? dflt;
  return scoreOf(m);
}

/** All four violations correctly flagged — the starting point for the FP calibration. */
const ALL_FOUR: Record<string, SectionVerdict> = { v1: "yes", v2: "yes", v3: "yes", v4: "yes" };

describe("passesThresholds — the gate", () => {
  it("a perfect model passes", () => {
    const s = verdicts("no", { v1: "yes", v2: "yes", v3: "yes", v4: "yes" });
    expect(s.microF1).toBe(1);
    expect(passesThresholds(s).pass).toBe(true);
  });

  it("SILENCE cannot pass — the recall floor exists for exactly this", () => {
    // 'Answer CLEAN to everything' asserts nothing, so it is never WRONG: precision is
    // vacuously 1.0 and F1 alone would not punish it hard enough on a corpus with more
    // clean files than violations. The explicit recall floor makes it structurally
    // impossible. This is the single most important assertion in the file.
    const s = verdicts("no");
    expect(s.microPrecision).toBe(1); // vacuously — it asserted nothing
    expect(s.microRecall).toBe(0);
    const r = passesThresholds(s);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/micro-recall/);
  });

  it("FLAGGING EVERYTHING cannot pass — precision is what precision is for", () => {
    const s = verdicts("yes");
    expect(s.microRecall).toBe(1);
    expect(passesThresholds(s).pass).toBe(false);
  });

  it("calibration: catching 3 of 4 with a clean sheet PASSES; missing a second does not", () => {
    // Pinned because the tolerance is a FUNCTION of the violation count (4). A corpus
    // edit that changed that count would silently change how many misses are allowed.
    const missOne = verdicts("no", { v1: "yes", v2: "yes", v3: "yes" }); // v4 missed
    expect(missOne.microRecall).toBeCloseTo(0.75, 5);
    expect(missOne.microF1).toBeCloseTo(0.857, 3);
    expect(passesThresholds(missOne).pass).toBe(true);

    const missTwo = verdicts("no", { v1: "yes", v2: "yes" });
    expect(missTwo.microRecall).toBeCloseTo(0.5, 5);
    expect(passesThresholds(missTwo).pass).toBe(false);
  });

  it("calibration: full recall survives an over-cautious flag; three of them do not", () => {
    // test-helpers.test.ts is a real file a careful auditor could over-worry about, so the
    // bar prices in a couple of such flags — and stops there.
    const oneFp = verdicts("no", { ...ALL_FOUR, c1: "yes" });
    expect(oneFp.microF1).toBeCloseTo(0.889, 3);
    expect(passesThresholds(oneFp).pass).toBe(true);

    // TWO false positives land EXACTLY on the bar (P=4/6, R=1 → F1=0.80). Asserted as a
    // boundary fact rather than as pass/fail, because a knife-edge equality is the one
    // thing a gate should never be read as promising.
    const twoFp = verdicts("no", { ...ALL_FOUR, c1: "yes", c2: "yes" });
    expect(twoFp.microF1).toBeCloseTo(0.8, 6);

    const threeFp = verdicts("no", { ...ALL_FOUR, c1: "yes", c2: "yes", c3: "yes" });
    expect(threeFp.microF1).toBeCloseTo(0.727, 3);
    expect(passesThresholds(threeFp).pass).toBe(false);
  });

  it("calibration: one miss AND one over-flag together do NOT pass", () => {
    const s = verdicts("no", { v1: "yes", v2: "yes", v3: "yes", c1: "yes" });
    expect(s.microF1).toBeCloseTo(0.75, 5);
    expect(passesThresholds(s).pass).toBe(false);
  });

  it("too many unparseable reports sink the run — an outage is not a score", () => {
    // A model that will not follow the output contract, and an API that is down, land in
    // the same place: no evidence about the model.
    const s = scoreOf({ v1: "yes", v2: "yes", v3: "yes", v4: "yes", c1: "no", c2: "no" });
    // 7 files never got a verdict at all → coverage 6/13.
    expect(s.coverage).toBeCloseTo(6 / 13, 5);
    const r = passesThresholds(s);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/coverage/);
  });

  it("the bar is 0.80 F1 / 0.70 recall / 0.90 coverage — stated, not inherited", () => {
    expect(DEFAULT_CHECK_SPECS_THRESHOLDS).toEqual({
      minMicroF1: 0.8,
      minMicroRecall: 0.7,
      minCoverage: 0.9,
    });
  });
});

describe("accuracyOf — reported, never gated", () => {
  it("flatters the useless, which is precisely why it is not the gate", () => {
    // A model that answers CLEAN to all 13 files finds nothing at all — and scores 0.69
    // accuracy, because 9 of the 13 files really are clean. If accuracy were the gate,
    // silence would be a B grade. It is reported next to F1 and recall, never instead.
    const silent = verdicts("no");
    expect(accuracyOf(silent)).toBeCloseTo(9 / 13, 5);
    expect(passesThresholds(silent).pass).toBe(false);
  });

  it("counts an unscored file as not-correct, exactly as coverage does", () => {
    const s = scoreOf({ v1: "yes", v2: "yes", v3: "yes", v4: "yes" });
    expect(accuracyOf(s)).toBeCloseTo(4 / 13, 5);
  });

  it("is 1.0 for a perfect model", () => {
    expect(accuracyOf(verdicts("no", { v1: "yes", v2: "yes", v3: "yes", v4: "yes" }))).toBe(1);
  });
});

describe("NAIVE_STRATEGIES — the adversaries the corpus must defeat", () => {
  // Their SCORES against the real corpus are asserted in bench-runner.test.ts, where they
  // are pushed through the real pipeline and the real scorer. Here we only pin their
  // behaviour, so a future edit cannot quietly turn one of them into a no-op that
  // "passes" the discrimination check by never asserting anything.
  it("carries four strategies, all of them code-blind", () => {
    expect(NAIVE_STRATEGIES.map((s) => s.id)).toEqual([
      "flag-everything",
      "flag-nothing",
      "spec-vocabulary-grep",
      "missing-live-gate-grep",
    ]);
  });

  it("the vocabulary grep really does grep the vocabulary", () => {
    const s = NAIVE_STRATEGIES.find((x) => x.id === "spec-vocabulary-grep")!;
    expect(s.decide("const x = process.env.OPENROUTER_API_KEY;")).toBe("yes");
    expect(s.decide("import { parseFileGroups } from './grouping';")).toBe("no");
  });

  it("the live-gate grep really does encode spec rule R2", () => {
    const s = NAIVE_STRATEGIES.find((x) => x.id === "missing-live-gate-grep")!;
    expect(s.decide("const LIVE = process.env.LIVE_TESTS === '1';")).toBe("no");
    expect(s.decide("describe('chat (live)', () => {});")).toBe("yes");
  });
});
