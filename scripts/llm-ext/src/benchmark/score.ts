/**
 * Scoring: compare a model's returned arrays against the ground truth.
 *
 * Each keyword is scored independently as precision / recall / F1
 * against the expected set. A model "PASSES" the overall benchmark iff
 * every returned array exactly equals the expected set (zero missed,
 * zero extra). Partial credit is still reported so models that almost
 * made it can be ranked.
 */

import type { GroundTruth } from "./ground-truth.js";
import type { RunResult } from "./runner.js";

export interface PerKeywordScore {
  expected: string[];
  returned: string[];
  truePositives: string[];
  falsePositives: string[];
  falseNegatives: string[];
  precision: number;
  recall: number;
  f1: number;
  exactMatch: boolean;
}

export interface ModelScore {
  modelId: string;
  pass: boolean;
  /** Mean F1 across the three keyword buckets. */
  meanF1: number;
  perKeyword: [PerKeywordScore, PerKeywordScore, PerKeywordScore];
  /** Model-reported function names that don't match any real function. */
  hallucinated: string[];
}

export function scoreRun(run: RunResult, truth: GroundTruth): ModelScore {
  const returned: [string[], string[], string[]] = [run.kw1, run.kw2, run.kw3];
  const perKeyword = [0, 1, 2].map((i) => scoreSet(truth.keywordFunctions[i], returned[i])) as [
    PerKeywordScore,
    PerKeywordScore,
    PerKeywordScore,
  ];

  const allReal = new Set(truth.allFunctions);
  const hallucinatedSet = new Set<string>();
  for (const arr of returned) {
    for (const name of arr) {
      if (!allReal.has(name)) hallucinatedSet.add(name);
    }
  }

  const pass = perKeyword.every((s) => s.exactMatch);
  const meanF1 = perKeyword.reduce((acc, s) => acc + s.f1, 0) / 3;
  return {
    modelId: run.modelId,
    pass,
    meanF1,
    perKeyword,
    hallucinated: [...hallucinatedSet].sort(),
  };
}

function scoreSet(expectedArr: readonly string[], returnedArr: readonly string[]): PerKeywordScore {
  const expected = new Set(expectedArr);
  const returned = new Set(returnedArr);
  const truePositives: string[] = [];
  const falsePositives: string[] = [];
  const falseNegatives: string[] = [];
  for (const name of returned) {
    if (expected.has(name)) truePositives.push(name);
    else falsePositives.push(name);
  }
  for (const name of expected) {
    if (!returned.has(name)) falseNegatives.push(name);
  }
  const tp = truePositives.length;
  const fp = falsePositives.length;
  const fn = falseNegatives.length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    expected: [...expected].sort(),
    returned: [...returned].sort(),
    truePositives: truePositives.sort(),
    falsePositives: falsePositives.sort(),
    falseNegatives: falseNegatives.sort(),
    precision,
    recall,
    f1,
    exactMatch: fp === 0 && fn === 0,
  };
}
