// Tests for the scan_folder (MASS SEARCH) deterministic scorer — P2c.
//
// The scorer is pure code (no network, no LLM), so every test here is the real
// thing: real reports in, real confusion matrix out. Never mock the thing under
// test.

import { describe, it, expect } from "vitest";

import { scoreCase, aggregateScores, type SectionVerdict } from "../search-existing/score.js";
import {
  DEFAULT_SCAN_FOLDER_THRESHOLDS,
  parseFileVerdict,
  passesThresholds,
} from "./score.js";

describe("parseFileVerdict — the anchored contract", () => {
  it("reads the contract's exact shapes", () => {
    expect(parseFileVerdict("MATCH: spawnSync from node:child_process").verdict).toBe("yes");
    expect(parseFileVerdict("NO_MATCH").verdict).toBe("no");
  });

  it("keeps the MATCH line's citation (reported, never graded)", () => {
    expect(parseFileVerdict("MATCH: spawnSync at line 11").evidence).toBe("spawnSync at line 11");
    // A MATCH with no citation is still a MATCH — the VERDICT is what is graded.
    expect(parseFileVerdict("MATCH").verdict).toBe("yes");
    expect(parseFileVerdict("MATCH").evidence).toBe("");
  });

  it("tolerates the decorations models add without changing the contract", () => {
    expect(parseFileVerdict("**MATCH:** `writeFileSync`").verdict).toBe("yes");
    expect(parseFileVerdict("- MATCH — createWriteStream(filePath)").verdict).toBe("yes");
    expect(parseFileVerdict("## NO_MATCH").verdict).toBe("no");
    expect(parseFileVerdict("**NO_MATCH**").verdict).toBe("no");
    expect(parseFileVerdict("no match").verdict).toBe("no");
    expect(parseFileVerdict("NO-MATCH").verdict).toBe("no");
  });

  it("never reads NO_MATCH as a MATCH", () => {
    // NO_MATCH literally contains MATCH. A scorer that tested the positive pattern
    // first — or loosened the anchor — would invert the verdict on every clean file
    // and hand a perfect-recall/zero-precision score to a model that said no.
    for (const line of ["NO_MATCH", "**NO_MATCH**", "- NO_MATCH", "no_match", "NO MATCH"]) {
      expect(parseFileVerdict(line).verdict).toBe("no");
    }
  });

  it("takes the FIRST anchored line — a later musing does not overturn the answer", () => {
    const report = "NO_MATCH\n\nAlthough it does call writeFileSync in a comment example.";
    expect(parseFileVerdict(report).verdict).toBe("no");
  });

  it("ignores fenced code — a model quoting the file must not be quoting a verdict", () => {
    const report = ["```ts", "// MATCH: this is quoted source, not a verdict", "```", "NO_MATCH"].join(
      "\n",
    );
    expect(parseFileVerdict(report).verdict).toBe("no");
  });

  it("does not read a verdict out of mid-sentence prose", () => {
    // The word must open the line. Otherwise "these files MATCH: none" scores YES.
    expect(parseFileVerdict("I would say this is a MATCH: yes").verdict).toBe("unparseable");
  });

  it("reports an unstated verdict as UNPARSEABLE rather than guessing", () => {
    // There is deliberately NO free-text fallback: guessing a binary verdict out of
    // prose that refused to state one means interpreting its meaning, which is a
    // judge. Unparseable costs coverage (and recall on a real match) — it is never
    // silently dropped.
    expect(parseFileVerdict("This file looks like it writes some things.").verdict).toBe(
      "unparseable",
    );
    expect(parseFileVerdict("").verdict).toBe("unparseable");
  });
});

describe("the gate", () => {
  const FILES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
  const EXPECTED = new Set(["a.ts", "b.ts"]);

  const verdicts = (v: Record<string, SectionVerdict>): Map<string, SectionVerdict> =>
    new Map(Object.entries(v));

  it("a perfect run passes", () => {
    const score = aggregateScores([
      scoreCase(
        "q",
        FILES,
        EXPECTED,
        verdicts({ "a.ts": "yes", "b.ts": "yes", "c.ts": "no", "d.ts": "no", "e.ts": "no" }),
      ),
    ]);
    expect(score.microF1).toBe(1);
    expect(passesThresholds(score).pass).toBe(true);
  });

  it("PERPETUAL SILENCE cannot pass — the recall floor is the load-bearing gate", () => {
    // The single most important property. "NO_MATCH to everything" asserts nothing,
    // so it is never WRONG: precision is vacuously 1 and, on any corpus with more
    // negatives than positives, F1 alone can look respectable. The explicit recall
    // floor makes the strategy structurally unable to pass, whatever the mix.
    const score = aggregateScores([
      scoreCase(
        "q",
        FILES,
        EXPECTED,
        verdicts({ "a.ts": "no", "b.ts": "no", "c.ts": "no", "d.ts": "no", "e.ts": "no" }),
      ),
    ]);
    expect(score.microPrecision).toBe(1); // nothing asserted → nothing asserted wrongly
    expect(score.microRecall).toBe(0);
    expect(score.coverage).toBe(1); // it followed the format perfectly, too
    const gate = passesThresholds(score);
    expect(gate.pass).toBe(false);
    expect(gate.failures.join(" ")).toMatch(/micro-recall/);
  });

  it("MATCH-to-everything cannot pass either — precision collapses", () => {
    const score = aggregateScores([
      scoreCase(
        "q",
        FILES,
        EXPECTED,
        verdicts({ "a.ts": "yes", "b.ts": "yes", "c.ts": "yes", "d.ts": "yes", "e.ts": "yes" }),
      ),
    ]);
    expect(score.microRecall).toBe(1);
    expect(score.microPrecision).toBeCloseTo(0.4, 5);
    expect(passesThresholds(score).pass).toBe(false);
  });

  it("a model that will not follow the output contract fails on COVERAGE", () => {
    // Every verdict correct in spirit, but only 3 of 5 files produced a parseable
    // one. The run is not evidence about the model's judgment, so it must not pass
    // on the strength of the files that did parse.
    const score = aggregateScores([
      scoreCase(
        "q",
        FILES,
        EXPECTED,
        verdicts({ "a.ts": "yes", "b.ts": "yes", "c.ts": "no" }),
      ),
    ]);
    expect(score.coverage).toBeCloseTo(0.6, 5);
    const gate = passesThresholds(score);
    expect(gate.pass).toBe(false);
    expect(gate.failures.join(" ")).toMatch(/coverage/);
  });

  it("an unparseable verdict on a real match is a MISS, not a free pass", () => {
    const score = aggregateScores([
      scoreCase("q", FILES, EXPECTED, verdicts({ "a.ts": "yes", "c.ts": "no", "d.ts": "no", "e.ts": "no" })),
    ]);
    // b.ts (a true match) produced nothing → false negative, not "excused".
    expect(score.microRecall).toBeCloseTo(0.5, 5);
  });

  it("holds scan_folder's own bar — the same 0.85 as search_existing, NOT code_task's 0.5", () => {
    // Both tools force a per-file binary verdict, so noise is not structural and a
    // coin flip (~0.5 on a balanced binary) must not clear the bar. code_task's 0.5
    // is right for a FREE-FORM review, where a good reviewer legitimately loses
    // precision by raising an unlisted concern. Pinning the numbers so a future edit
    // to either tool's gate cannot silently move this one.
    expect(DEFAULT_SCAN_FOLDER_THRESHOLDS).toEqual({
      minMicroF1: 0.85,
      minMicroRecall: 0.85,
      minCoverage: 0.9,
    });
  });

  it("tolerates ONE miss out of ten real matches, but not two", () => {
    // Calibration of what 0.85 actually costs a model, on the shape of the REAL
    // corpus: 10 true matches across the three queries. One miss → recall 0.90,
    // which clears the floor. Two → recall 0.80, which does not. The bar is
    // demanding but not brittle, and it is the RECALL floor (not F1) that binds —
    // worth pinning, because a corpus edit that changed the positive count would
    // silently change the number of misses a model is allowed.
    const files = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    const truth = new Set(files.slice(0, 10));

    const build = (missing: number): Map<string, SectionVerdict> =>
      new Map(
        files.map((f, i) => [
          f,
          i < 10 && i >= missing ? "yes" : "no",
        ]) as [string, SectionVerdict][],
      );

    const oneMiss = aggregateScores([scoreCase("q", files, truth, build(1))]);
    expect(oneMiss.microRecall).toBeCloseTo(0.9, 5);
    expect(passesThresholds(oneMiss).pass).toBe(true);

    const twoMisses = aggregateScores([scoreCase("q", files, truth, build(2))]);
    expect(twoMisses.microRecall).toBeCloseTo(0.8, 5);
    const gate = passesThresholds(twoMisses);
    expect(gate.pass).toBe(false);
    expect(gate.failures.join(" ")).toMatch(/micro-recall/);
  });
});
