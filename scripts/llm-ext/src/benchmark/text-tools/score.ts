/**
 * Deterministic scorers for the four text-tool benchmarks. LLM-free: every
 * score is computed mechanically against the hand-curated dataset (dataset.ts).
 *
 * Concept hit = case-insensitive substring containment in EITHER direction
 * for multiword forms (so keyword "bees" hits concept form "bee", and concept
 * form "error correction" hits keyphrase "quantum error correction"). All
 * synonym tolerance lives in the dataset's concept forms, never here.
 */

import type {
  DescribeCase,
  SemDedupCase,
  SummarizeCase,
  TopicsCase,
} from "./dataset.js";
import { semDedupInput } from "./dataset.js";
import type { TopicsPayload } from "../../text-tools/core.js";

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** True when a concept form and an output term contain one another. */
function termMatches(form: string, term: string): boolean {
  const f = norm(form);
  const t = norm(term);
  if (!f || !t) return false;
  // An exact match always counts — without this, a legitimate short form
  // (a future "AI"/"ML" topics concept) could never match even a verbatim
  // identical model term, and would silently read as model weakness.
  if (f === t) return true;
  // Otherwise the contained operand must be ≥3 chars: a degenerate 1-2 char
  // output term would earn precision credit by landing inside a longer form.
  return (f.length >= 3 && t.includes(f)) || (t.length >= 3 && f.includes(t));
}

/** Fraction of concepts hit by the output text (substring over whole text). */
export function conceptRecall(text: string, concepts: readonly string[][]): number {
  if (concepts.length === 0) return 1;
  const hay = norm(text);
  let hit = 0;
  for (const forms of concepts) {
    if (forms.some((f) => hay.includes(norm(f)))) hit++;
  }
  return hit / concepts.length;
}

// ── summarize ──────────────────────────────────────────────────────────────

export interface SummarizeCaseScore {
  caseId: string;
  withinBudget: boolean;
  conceptRecall: number;
  /** 0 when over budget (a blown budget is a contract violation, not a style
   *  nit — the tool's whole promise is the size bound). */
  score: number;
}

export function scoreSummarizeCase(
  c: SummarizeCase,
  summary: string,
): SummarizeCaseScore {
  const withinBudget = summary.length <= c.maxChars && summary.trim().length > 0;
  const recall = conceptRecall(summary, c.concepts);
  return {
    caseId: c.id,
    withinBudget,
    conceptRecall: recall,
    score: withinBudget ? recall : 0,
  };
}

// ── topics ─────────────────────────────────────────────────────────────────

export interface TopicsCaseScore {
  caseId: string;
  languageMatch: boolean;
  conceptRecall: number;
  /** Fraction of output terms that hit SOME expected concept (precision-ish —
   *  punishes hallucinated off-topic terms). */
  termPrecision: number;
  score: number;
}

export function scoreTopicsCase(c: TopicsCase, payload: TopicsPayload): TopicsCaseScore {
  const languageMatch = c.language.some((l) => norm(payload.language).startsWith(norm(l)));
  const terms = [...payload.keywords, ...payload.keyphrases];
  let conceptHits = 0;
  for (const forms of c.concepts) {
    if (forms.some((f) => terms.some((t) => termMatches(f, t)))) conceptHits++;
  }
  const recall = c.concepts.length === 0 ? 1 : conceptHits / c.concepts.length;
  const precise =
    terms.length === 0
      ? 0
      : terms.filter((t) => c.concepts.some((forms) => forms.some((f) => termMatches(f, t))))
          .length / terms.length;
  // Language is a hard half-gate: wrong language halves the case score
  // (the tool's contract says "including the language").
  const base = recall * 0.7 + precise * 0.3;
  return {
    caseId: c.id,
    languageMatch,
    conceptRecall: recall,
    termPrecision: precise,
    score: languageMatch ? base : base * 0.5,
  };
}

// ── sem_deduplicate ────────────────────────────────────────────────────────

export interface SemDedupCaseScore {
  caseId: string;
  /** Clusters represented by EXACTLY one survivor. */
  exactClusters: number;
  totalClusters: number;
  /** Survivors that map to no cluster (should be impossible given the subset
   *  guard, kept for safety). */
  strays: number;
  score: number;
}

/**
 * Score survivors against the case's meaning clusters: perfect output keeps
 * exactly one phrase per cluster. Score = exactly-one clusters / total.
 * Keeping two of a pair (missed duplicate) or zero (over-deleted a meaning)
 * both cost that cluster.
 */
export function scoreSemDedupCase(c: SemDedupCase, survivors: string[]): SemDedupCaseScore {
  const byPhrase = new Map<string, number>();
  c.clusters.forEach((cl, i) => cl.forEach((p) => byPhrase.set(norm(p), i)));
  const counts = new Array<number>(c.clusters.length).fill(0);
  let strays = 0;
  for (const s of survivors) {
    const ci = byPhrase.get(norm(s));
    if (ci === undefined) strays++;
    else counts[ci]++;
  }
  const exact = counts.filter((n) => n === 1).length;
  const raw = exact / c.clusters.length;
  return {
    caseId: c.id,
    exactClusters: exact,
    totalClusters: c.clusters.length,
    strays,
    score: strays > 0 ? 0 : raw,
  };
}

/** Convenience for runners/tests: the input list the tool receives. */
export { semDedupInput };

// ── describe ───────────────────────────────────────────────────────────────

export interface DescribeCaseScore {
  caseId: string;
  withinBudget: boolean;
  conceptRecall: number;
  score: number;
}

export function scoreDescribeCase(c: DescribeCase, description: string): DescribeCaseScore {
  const withinBudget =
    description.length <= c.maxChars && description.trim().length > 0;
  const recall = conceptRecall(description, c.concepts);
  return {
    caseId: c.id,
    withinBudget,
    conceptRecall: recall,
    score: withinBudget ? recall : 0,
  };
}

// ── Aggregation + thresholds (shared across the four tools) ────────────────

export interface TextToolScore {
  /** Mean per-case score over the whole dataset (failed cases count as 0). */
  meanScore: number;
  /** Cases whose pipeline run FAILED outright (isError / seam error). */
  failedCases: number;
  totalCases: number;
}

export interface TextToolThresholds {
  minMeanScore: number;
  maxFailedCases: number;
}

/**
 * One pass bar for all four tools. 0.6 mean concept-based score is a real bar
 * (a competent model scores 0.8+ on this corpus; an echoing or off-task model
 * lands near 0), and one hard-failed case of six is the tolerance for a flaky
 * provider response — two means the model can't run the pipeline.
 */
export const DEFAULT_TEXT_TOOL_THRESHOLDS: TextToolThresholds = {
  minMeanScore: 0.6,
  maxFailedCases: 1,
};

export function aggregateTextToolScores(
  caseScores: readonly number[],
  failedCases: number,
  totalCases: number,
): TextToolScore {
  const sum = caseScores.reduce((a, b) => a + b, 0);
  // Failed cases contribute 0 to the mean over the FULL dataset size.
  const meanScore = totalCases === 0 ? 0 : sum / totalCases;
  return { meanScore, failedCases, totalCases };
}

export function passesTextToolThresholds(
  agg: TextToolScore,
  t: TextToolThresholds = DEFAULT_TEXT_TOOL_THRESHOLDS,
): { pass: boolean; reason: string } {
  if (agg.failedCases > t.maxFailedCases) {
    return {
      pass: false,
      reason: `${agg.failedCases}/${agg.totalCases} cases failed to run (max ${t.maxFailedCases})`,
    };
  }
  if (agg.meanScore < t.minMeanScore) {
    return {
      pass: false,
      reason: `mean score ${agg.meanScore.toFixed(3)} below the ${t.minMeanScore} bar`,
    };
  }
  return { pass: true, reason: `mean score ${agg.meanScore.toFixed(3)}` };
}
