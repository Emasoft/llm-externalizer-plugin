// Unit tests for the DETERMINISTIC text-tool scorers. Pure — no LLM, no
// network, no judge. Every assertion is a contract the paid sweep relies on:
// a wrong budget check or a wrong cluster count silently mis-scores every
// model in a real run.

import { describe, it, expect } from "vitest";

import type { DescribeCase, SemDedupCase, SummarizeCase, TopicsCase } from "./dataset.js";
import type { TopicsPayload } from "../../text-tools/core.js";
import {
  DEFAULT_TEXT_TOOL_THRESHOLDS,
  aggregateTextToolScores,
  passesTextToolThresholds,
  scoreDescribeCase,
  scoreSemDedupCase,
  scoreSummarizeCase,
  scoreTopicsCase,
} from "./score.js";

function summarizeCase(over: Partial<SummarizeCase> = {}): SummarizeCase {
  return {
    id: "sum-1",
    text: "irrelevant source text",
    maxChars: 30,
    concepts: [["alpha"], ["beta"]],
    ...over,
  };
}

function topicsCase(over: Partial<TopicsCase> = {}): TopicsCase {
  return {
    id: "top-1",
    text: "irrelevant source text",
    language: ["en", "english"],
    concepts: [["alpha"], ["beta"]],
    ...over,
  };
}

function semDedupCase(over: Partial<SemDedupCase> = {}): SemDedupCase {
  return {
    id: "sd-1",
    clusters: [["alpha one", "alpha two"], ["beta"], ["gamma one", "gamma two"]],
    ...over,
  };
}

function describeCase(over: Partial<DescribeCase> = {}): DescribeCase {
  return {
    id: "desc-1",
    fileName: "f.txt",
    content: "irrelevant content",
    maxChars: 30,
    concepts: [["alpha"], ["beta"]],
    ...over,
  };
}

describe("scoreSummarizeCase", () => {
  it("within budget + every concept present scores 1", () => {
    const c = summarizeCase();
    const s = scoreSummarizeCase(c, "text with alpha and beta");
    expect(s.withinBudget).toBe(true);
    expect(s.conceptRecall).toBe(1);
    expect(s.score).toBe(1);
  });

  it("over the character budget scores 0, whatever the recall", () => {
    const c = summarizeCase({ maxChars: 10 });
    const s = scoreSummarizeCase(c, "text with alpha and beta"); // 24 chars > 10
    expect(s.withinBudget).toBe(false);
    expect(s.conceptRecall).toBe(1); // recall is still measured...
    expect(s.score).toBe(0); // ...but the contract violation zeroes the score
  });

  it("an empty summary is never within budget and scores 0", () => {
    const c = summarizeCase();
    const s = scoreSummarizeCase(c, "   ");
    expect(s.withinBudget).toBe(false);
    expect(s.score).toBe(0);
  });
});

describe("scoreTopicsCase", () => {
  const payload: TopicsPayload = { language: "en", keywords: ["alpha", "beta"], keyphrases: [] };

  it("right language + full concept hit scores high", () => {
    const c = topicsCase();
    const s = scoreTopicsCase(c, payload);
    expect(s.languageMatch).toBe(true);
    expect(s.conceptRecall).toBe(1);
    expect(s.score).toBeCloseTo(1, 6);
  });

  it("wrong language halves the score relative to the same payload in the right language", () => {
    const c = topicsCase();
    const right = scoreTopicsCase(c, payload);
    const wrong = scoreTopicsCase(c, { ...payload, language: "fr" });
    expect(wrong.languageMatch).toBe(false);
    expect(wrong.score).toBeCloseTo(right.score * 0.5, 6);
  });

  it("hallucinated off-topic terms drag term precision down", () => {
    const c = topicsCase();
    const focused = scoreTopicsCase(c, payload);
    const noisy = scoreTopicsCase(c, {
      ...payload,
      keywords: [...payload.keywords, "unrelated1", "unrelated2", "unrelated3"],
    });
    expect(noisy.conceptRecall).toBe(focused.conceptRecall); // still finds both concepts
    expect(noisy.termPrecision).toBeLessThan(focused.termPrecision);
    expect(noisy.score).toBeLessThan(focused.score);
  });
});

describe("scoreSemDedupCase", () => {
  it("exactly one survivor per cluster scores 1", () => {
    const c = semDedupCase();
    const s = scoreSemDedupCase(c, ["alpha one", "beta", "gamma one"]);
    expect(s.exactClusters).toBe(3);
    expect(s.strays).toBe(0);
    expect(s.score).toBe(1);
  });

  it("keeping BOTH members of a cluster (missed dedup) costs that cluster", () => {
    const c = semDedupCase();
    const s = scoreSemDedupCase(c, ["alpha one", "alpha two", "beta", "gamma one"]);
    expect(s.exactClusters).toBe(2); // the alpha cluster no longer counts as exact
    expect(s.strays).toBe(0);
    expect(s.score).toBeCloseTo(2 / 3, 6);
  });

  it("a stray survivor not in any cluster zeroes the whole case", () => {
    const c = semDedupCase();
    const s = scoreSemDedupCase(c, ["alpha one", "beta", "gamma one", "invented phrase"]);
    expect(s.strays).toBe(1);
    expect(s.score).toBe(0);
  });
});

describe("scoreDescribeCase", () => {
  it("within budget + full concept recall scores 1", () => {
    const c = describeCase();
    const s = scoreDescribeCase(c, "alpha and beta both present");
    expect(s.withinBudget).toBe(true);
    expect(s.score).toBe(1);
  });

  it("over the character budget scores 0", () => {
    const c = describeCase({ maxChars: 5 });
    const s = scoreDescribeCase(c, "alpha and beta both present");
    expect(s.withinBudget).toBe(false);
    expect(s.score).toBe(0);
  });
});

describe("aggregateTextToolScores + passesTextToolThresholds", () => {
  it("a model clearing the mean-score bar with few failures PASSES", () => {
    const agg = aggregateTextToolScores([1, 0.9, 0.8, 0.7], 0, 4);
    const thr = passesTextToolThresholds(agg, DEFAULT_TEXT_TOOL_THRESHOLDS);
    expect(thr.pass).toBe(true);
  });

  it("a model below the mean-score bar FAILS, and too many failed cases FAILS regardless of score", () => {
    const lowScore = aggregateTextToolScores([0.2, 0.1], 0, 2);
    expect(passesTextToolThresholds(lowScore).pass).toBe(false);
    expect(passesTextToolThresholds(lowScore).reason).toMatch(/below the/);

    const tooManyFailures = aggregateTextToolScores([1, 1], 2, 4); // 4 total, 2 failed > max 1
    expect(passesTextToolThresholds(tooManyFailures).pass).toBe(false);
    expect(passesTextToolThresholds(tooManyFailures).reason).toMatch(/cases failed to run/);
  });
});
