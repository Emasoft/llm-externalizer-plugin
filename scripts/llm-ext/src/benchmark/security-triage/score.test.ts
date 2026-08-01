// Unit tests for the security-triage scorer — pure, no network.
// Verifies under-flag weighting, the mandatory critical-case floor, the
// over-flag accounting, and the minScore pass gate.

import { describe, it, expect } from "vitest";

import type { Verdict } from "../../security_scan/types.js";
import type { SecurityTriageCase } from "./dataset.js";
import { scoreTriage, DEFAULT_TRIAGE_THRESHOLDS } from "./score.js";

function makeCase(over: Partial<SecurityTriageCase> & { id: string }): SecurityTriageCase {
  const expected: Verdict = over.expected ?? "threat";
  return {
    id: over.id,
    category: over.category ?? "ssrf",
    language: over.language,
    snippet: over.snippet ?? "code",
    expected,
    acceptable: over.acceptable ?? [expected],
    critical: over.critical ?? false,
    underflag: over.underflag,
    rationale: over.rationale ?? "r",
    source: over.source ?? "#test",
  };
}

function verdicts(pairs: Record<string, Verdict>): Map<string, Verdict> {
  return new Map(Object.entries(pairs));
}

describe("scoreTriage", () => {
  it("a perfect run scores 1.0, passes, and has zero under/over flags", () => {
    const cases = [
      makeCase({ id: "t1", expected: "threat", critical: true, underflag: "not_threat" }),
      makeCase({ id: "b1", expected: "not_threat" }),
      makeCase({ id: "u1", expected: "uncertain", underflag: "not_threat" }),
    ];
    const s = scoreTriage("m", cases, verdicts({ t1: "threat", b1: "not_threat", u1: "uncertain" }));
    expect(s.score).toBe(1);
    expect(s.pass).toBe(true);
    expect(s.underFlagCount).toBe(0);
    expect(s.overFlagCount).toBe(0);
    expect(s.appropriatelyUncertainCount).toBe(1);
    expect(s.failReasons).toHaveLength(0);
  });

  it("an under-flag on a CRITICAL case fails the gate even when the score is high", () => {
    // 9 perfect + 1 critical under-flag → score 8/10 = 0.8 (>= minScore) but FAIL.
    const cases = [
      makeCase({ id: "crit", expected: "threat", critical: true, underflag: "not_threat" }),
      ...Array.from({ length: 9 }, (_, i) =>
        makeCase({ id: `ok${i}`, expected: "not_threat" }),
      ),
    ];
    const got: Record<string, Verdict> = { crit: "not_threat" };
    for (let i = 0; i < 9; i++) got[`ok${i}`] = "not_threat";
    const s = scoreTriage("m", cases, verdicts(got));
    expect(s.criticalUnderFlags).toBe(1);
    expect(s.pass).toBe(false);
    expect(s.failReasons.join(" ")).toMatch(/critical case\(s\) under-flagged/);
    expect(s.failReasons.join(" ")).toContain("crit");
  });

  it("under-flags are weighted heaviest: a false-clear scores below a false-positive", () => {
    const tainted = [makeCase({ id: "x", expected: "threat", critical: false, underflag: "not_threat" })];
    const benign = [makeCase({ id: "y", expected: "not_threat" })];

    const underFlagRun = scoreTriage("m", tainted, verdicts({ x: "not_threat" })); // -1
    const overFlagRun = scoreTriage("m", benign, verdicts({ y: "threat" })); // 0

    expect(underFlagRun.score).toBe(-1);
    expect(overFlagRun.score).toBe(0);
    expect(underFlagRun.score).toBeLessThan(overFlagRun.score);
    expect(underFlagRun.underFlagCount).toBe(1);
    expect(overFlagRun.overFlagCount).toBe(1);
  });

  it("an over-cautious uncertain on a real threat scores 0 (not negative) — safe direction", () => {
    const cases = [makeCase({ id: "x", expected: "threat", underflag: "not_threat" })];
    const s = scoreTriage("m", cases, verdicts({ x: "uncertain" }));
    expect(s.score).toBe(0);
    expect(s.underFlagCount).toBe(0);
    expect(s.correctCount).toBe(0);
  });

  it("acceptable verdicts also count as correct (e.g. clamped uncertain)", () => {
    const cases = [
      makeCase({ id: "judge", expected: "uncertain", acceptable: ["uncertain", "threat"], critical: true, underflag: "not_threat" }),
    ];
    const asThreat = scoreTriage("m", cases, verdicts({ judge: "threat" }));
    const asUncertain = scoreTriage("m", cases, verdicts({ judge: "uncertain" }));
    expect(asThreat.correctCount).toBe(1);
    expect(asUncertain.correctCount).toBe(1);
    expect(asThreat.pass).toBe(true);
    expect(asUncertain.pass).toBe(true);
  });

  it("the minScore gate fails a model that is correct-but-mediocre with no critical under-flags", () => {
    // 10 benign cases, model over-flags 8 of them → score 2/10 = 0.2 < 0.5.
    const cases = Array.from({ length: 10 }, (_, i) => makeCase({ id: `b${i}`, expected: "not_threat" }));
    const got: Record<string, Verdict> = {};
    for (let i = 0; i < 10; i++) got[`b${i}`] = i < 8 ? "threat" : "not_threat";
    const s = scoreTriage("m", cases, verdicts(got));
    expect(s.criticalUnderFlags).toBe(0);
    expect(s.score).toBeCloseTo(0.2, 5);
    expect(s.pass).toBe(false);
    expect(s.failReasons.join(" ")).toMatch(/minScore/);
  });

  it("rates are computed over the dataset size", () => {
    const cases = [
      makeCase({ id: "a", expected: "threat", critical: true, underflag: "not_threat" }),
      makeCase({ id: "b", expected: "not_threat" }),
      makeCase({ id: "c", expected: "not_threat" }),
      makeCase({ id: "d", expected: "uncertain", underflag: "not_threat" }),
    ];
    const s = scoreTriage("m", cases, verdicts({ a: "threat", b: "threat", c: "not_threat", d: "not_threat" }));
    expect(s.total).toBe(4);
    expect(s.overFlagCount).toBe(1); // b
    expect(s.underFlagCount).toBe(1); // d (not_threat on an expected-uncertain underflag case)
    expect(s.overFlagRate).toBeCloseTo(0.25, 5);
    expect(s.underFlagRate).toBeCloseTo(0.25, 5);
  });

  it("throws if a case has no returned verdict (incomplete run)", () => {
    const cases = [makeCase({ id: "a", expected: "threat", underflag: "not_threat" })];
    expect(() => scoreTriage("m", cases, verdicts({}))).toThrow(/no verdict returned/);
  });

  it("respects a custom minScore threshold", () => {
    const cases = [
      makeCase({ id: "a", expected: "not_threat" }),
      makeCase({ id: "b", expected: "not_threat" }),
    ];
    // 1/2 correct → score 0.5.
    const got = verdicts({ a: "not_threat", b: "threat" });
    expect(scoreTriage("m", cases, got, { minScore: 0.5, maxErrorRate: 0.15 }).pass).toBe(true);
    expect(scoreTriage("m", cases, got, { minScore: 0.75, maxErrorRate: 0.15 }).pass).toBe(false);
    expect(DEFAULT_TRIAGE_THRESHOLDS.minScore).toBe(0.5);
    expect(DEFAULT_TRIAGE_THRESHOLDS.maxErrorRate).toBe(0.15);
  });

  it("EXCLUDES fail-safe (errored) cases from scoring — infra noise is not a verdict", () => {
    // 2 real cases (both correct) + 1 errored → score over the 2 real = 1.0.
    const cases = [
      makeCase({ id: "a", expected: "not_threat" }),
      makeCase({ id: "b", expected: "threat", critical: true, underflag: "not_threat" }),
      makeCase({ id: "c", expected: "threat", critical: true, underflag: "not_threat" }),
    ];
    // c errored → its (fail-safe) "uncertain" must not count against the model.
    const got = verdicts({ a: "not_threat", b: "threat", c: "uncertain" });
    const failSafe = new Map([["c", true]]);
    const s = scoreTriage("m", cases, got, DEFAULT_TRIAGE_THRESHOLDS, failSafe);
    expect(s.erroredCount).toBe(1);
    expect(s.scoredCount).toBe(2);
    expect(s.correctCount).toBe(2);
    expect(s.score).toBe(1);
    // A fail-safe on a CRITICAL case is NOT a critical under-flag (no model verdict).
    expect(s.criticalUnderFlags).toBe(0);
    expect(s.perCase.find((p) => p.id === "c")?.errored).toBe(true);
  });

  it("marks a run INCONCLUSIVE (and not pass) when the error rate exceeds maxErrorRate", () => {
    // 10 cases, 3 errored → errorRate 0.3 > 0.15 → inconclusive.
    const cases = Array.from({ length: 10 }, (_, i) => makeCase({ id: `c${i}`, expected: "not_threat" }));
    const got: Record<string, Verdict> = {};
    for (let i = 0; i < 10; i++) got[`c${i}`] = "not_threat";
    const failSafe = new Map([["c0", true], ["c1", true], ["c2", true]]);
    const s = scoreTriage("m", cases, verdicts(got), DEFAULT_TRIAGE_THRESHOLDS, failSafe);
    expect(s.errorRate).toBeCloseTo(0.3, 5);
    expect(s.inconclusive).toBe(true);
    expect(s.pass).toBe(false);
    expect(s.failReasons.join(" ")).toMatch(/INCONCLUSIVE/);
  });

  it("a low error rate (≤ maxErrorRate) stays conclusive and scores normally", () => {
    // 10 cases, 1 errored → errorRate 0.1 ≤ 0.15 → conclusive; 9 real all correct.
    const cases = Array.from({ length: 10 }, (_, i) => makeCase({ id: `c${i}`, expected: "not_threat" }));
    const got: Record<string, Verdict> = {};
    for (let i = 0; i < 10; i++) got[`c${i}`] = "not_threat";
    const failSafe = new Map([["c0", true]]);
    const s = scoreTriage("m", cases, verdicts(got), DEFAULT_TRIAGE_THRESHOLDS, failSafe);
    expect(s.inconclusive).toBe(false);
    expect(s.scoredCount).toBe(9);
    expect(s.score).toBe(1);
    expect(s.pass).toBe(true);
  });
});
