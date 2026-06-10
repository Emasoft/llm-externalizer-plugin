// Tests for the deterministic search-existing scorer (TRDD-828238b5 A6).
// Each test's name string is its one-line description.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_EXISTING_THRESHOLDS,
  aggregateScores,
  parseSectionVerdict,
  passesThresholds,
  scoreCase,
} from "./score.js";

describe("parseSectionVerdict", () => {
  it("classifies a bare NO line as no", () => {
    expect(parseSectionVerdict("NO\n")).toBe("no");
  });

  it("classifies the self-reference NO variant as no", () => {
    expect(parseSectionVerdict("NO (self-reference)")).toBe("no");
  });

  it("classifies a YES finding line as yes", () => {
    expect(parseSectionVerdict("YES symbol=withRetry lines=24-40")).toBe("yes");
  });

  it("lets YES dominate when both YES and NO lines appear", () => {
    expect(parseSectionVerdict("NO\nYES symbol=fetchJson lines=22-45")).toBe(
      "yes",
    );
  });

  it("treats multiple YES findings in one section as yes", () => {
    expect(
      parseSectionVerdict(
        "YES symbol=withRetry lines=24-40\nYES symbol=sleep lines=14-16",
      ),
    ).toBe("yes");
  });

  it("marks prose without any YES/NO verdict line as unparseable", () => {
    expect(parseSectionVerdict("The file implements retries.")).toBe(
      "unparseable",
    );
  });

  it("marks an empty section as unparseable", () => {
    expect(parseSectionVerdict("\n  \n---\n")).toBe("unparseable");
  });

  it("does not mistake words starting with NO/YES for verdicts", () => {
    expect(parseSectionVerdict("NOTHING matches\nYESTERDAY's code")).toBe(
      "unparseable",
    );
  });
});

const FILES = ["/fx/a.ts", "/fx/b.ts", "/fx/c.ts", "/fx/d.ts"] as const;

function verdicts(map: Record<string, "yes" | "no" | "unparseable">) {
  return new Map(Object.entries(map));
}

describe("scoreCase", () => {
  it("scores a perfect prediction as precision=recall=f1=1", () => {
    const s = scoreCase(
      "perfect",
      FILES,
      new Set(["/fx/a.ts"]),
      verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "no", "/fx/c.ts": "no", "/fx/d.ts": "no" }),
    );
    expect(s).toMatchObject({ truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 3, unscored: 0, precision: 1, recall: 1, f1: 1 });
  });

  it("counts a spurious YES as a false positive lowering precision", () => {
    const s = scoreCase(
      "fp",
      FILES,
      new Set(["/fx/a.ts"]),
      verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "yes", "/fx/c.ts": "no", "/fx/d.ts": "no" }),
    );
    expect(s.falsePositives).toBe(1);
    expect(s.precision).toBeCloseTo(0.5);
    expect(s.recall).toBe(1);
  });

  it("counts a missed duplicate as a false negative lowering recall", () => {
    const s = scoreCase(
      "fn",
      FILES,
      new Set(["/fx/a.ts", "/fx/b.ts"]),
      verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "no", "/fx/c.ts": "no", "/fx/d.ts": "no" }),
    );
    expect(s.falseNegatives).toBe(1);
    expect(s.recall).toBeCloseTo(0.5);
    expect(s.precision).toBe(1);
  });

  it("treats a missing verdict on an expected-YES file as a false negative", () => {
    const s = scoreCase(
      "missing-yes",
      FILES,
      new Set(["/fx/a.ts"]),
      verdicts({ "/fx/b.ts": "no", "/fx/c.ts": "no", "/fx/d.ts": "no" }),
    );
    expect(s.falseNegatives).toBe(1);
    expect(s.unscored).toBe(1);
  });

  it("tracks a missing verdict on an expected-NO file as unscored, not a false positive", () => {
    const s = scoreCase(
      "missing-no",
      FILES,
      new Set(["/fx/a.ts"]),
      verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "no", "/fx/c.ts": "no" }),
    );
    expect(s.falsePositives).toBe(0);
    expect(s.unscored).toBe(1);
    expect(s.precision).toBe(1);
  });

  it("scores an absent-feature case answered all-NO as a perfect 1/1/1", () => {
    const s = scoreCase(
      "absent",
      FILES,
      new Set<string>(),
      verdicts({ "/fx/a.ts": "no", "/fx/b.ts": "no", "/fx/c.ts": "no", "/fx/d.ts": "no" }),
    );
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.f1).toBe(1);
  });
});

describe("aggregateScores + passesThresholds", () => {
  const perfect = scoreCase(
    "p",
    FILES,
    new Set(["/fx/a.ts"]),
    verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "no", "/fx/c.ts": "no", "/fx/d.ts": "no" }),
  );
  const flawed = scoreCase(
    "f",
    FILES,
    new Set(["/fx/a.ts", "/fx/b.ts"]),
    verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "no", "/fx/c.ts": "yes", "/fx/d.ts": "no" }),
  );

  it("micro-averages over pooled confusion counts across cases", () => {
    const agg = aggregateScores([perfect, flawed]);
    // pooled: TP=2, FP=1, FN=1 → P=2/3, R=2/3
    expect(agg.microPrecision).toBeCloseTo(2 / 3);
    expect(agg.microRecall).toBeCloseTo(2 / 3);
    expect(agg.microF1).toBeCloseTo(2 / 3);
  });

  it("macro-averages the per-case f1 values unweighted", () => {
    const agg = aggregateScores([perfect, flawed]);
    expect(agg.macroF1).toBeCloseTo((1 + flawed.f1) / 2);
  });

  it("computes coverage as the parsed fraction of scanned files", () => {
    const withMissing = scoreCase(
      "m",
      FILES,
      new Set(["/fx/a.ts"]),
      verdicts({ "/fx/a.ts": "yes", "/fx/b.ts": "no" }),
    );
    const agg = aggregateScores([withMissing]);
    expect(agg.coverage).toBeCloseTo(0.5);
  });

  it("passes the default thresholds on an all-perfect run", () => {
    const agg = aggregateScores([perfect]);
    expect(passesThresholds(agg)).toEqual({ pass: true, failures: [] });
  });

  it("reports every failed axis with its measured value", () => {
    const bad = scoreCase(
      "bad",
      FILES,
      new Set(["/fx/a.ts", "/fx/b.ts"]),
      verdicts({ "/fx/c.ts": "yes" }),
    );
    const verdict = passesThresholds(aggregateScores([bad]), {
      ...DEFAULT_SEARCH_EXISTING_THRESHOLDS,
    });
    expect(verdict.pass).toBe(false);
    expect(verdict.failures.join("; ")).toMatch(/micro-F1/);
    expect(verdict.failures.join("; ")).toMatch(/micro-recall/);
    expect(verdict.failures.join("; ")).toMatch(/coverage/);
  });
});
