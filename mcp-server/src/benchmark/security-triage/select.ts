/**
 * Selection gate for the security_scan triage model (TRDD-973a0265 §3.4).
 *
 * A candidate may become the security_scan default ONLY if it clears THREE
 * independent gates:
 *   1. REQUIREMENTS — passes `qualify()` against SECURITY_TRIAGE_CRITERIA (this
 *      tool's own per-tool requirements: structured output + a modest context,
 *      NOT the keyword-ensemble's 128K/reasoning bar). This is the reference
 *      instance of the per-tool requirements concept [[TRDD-f45eeaa0]].
 *   2. BENCHMARK — passes the security-triage golden-dataset benchmark
 *      (`TriageScore.pass`: zero critical under-flags + score ≥ minScore).
 *   3. COST — is NOT pricier than the incumbent default on EITHER axis. We never
 *      auto-bump to a pricier model (the user's standing same-cost rule). Among
 *      eligible same-or-cheaper passers, the best triage score wins (ties →
 *      lower cost → lower latency, mirroring pickTopN).
 *
 * Pure module — no network, no IO. The orchestrator (index.ts) feeds it the
 * assessed candidates; this decides the winner. Fully unit-testable.
 */

import {
  DEFAULT_CRITERIA,
  type ModelCriteria,
} from "../discover.js";
import type { TriageScore } from "./score.js";

/**
 * Per-tool requirements for the security_scan triage path. Differs from the
 * keyword-ensemble DEFAULT_CRITERIA: triage snippets are small and the verdict
 * output is ~200 bytes, so it needs structured output but neither a 128K context
 * nor 64K completion nor reasoning. The cost ceiling (< $1/M in AND out) is
 * inherited unchanged. This is exactly the "each tool has its own requirements"
 * the user asked for; #97 extracts a registry of these.
 */
export const SECURITY_TRIAGE_CRITERIA: ModelCriteria = {
  category: DEFAULT_CRITERIA.category,
  // Snippet windows are at most a few KB; the judge prompt is small. 16K is
  // plenty and keeps cheap small models (e.g. qwen-2.5-7b @ 32K) in the pool.
  minContextTokens: 16_000,
  // The verdict JSON is ~200 bytes. 1K completion headroom is ample.
  minOutputTokens: 1_000,
  maxInputDollarsPerMillion: DEFAULT_CRITERIA.maxInputDollarsPerMillion,
  maxOutputDollarsPerMillion: DEFAULT_CRITERIA.maxOutputDollarsPerMillion,
  requireStructuredOutputs: true,
  // Triage does NOT need a reasoning model — the json_schema verdict is a
  // direct classification. Requiring reasoning would wrongly exclude qwen-2.5-7b.
  requireReasoning: false,
  allowFree: false,
};

/** Tiny tolerance for float pricing noise when comparing $/M values. */
const COST_EPSILON = 1e-9;

export interface CandidateAssessment {
  modelId: string;
  /** Passed qualify() against SECURITY_TRIAGE_CRITERIA. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-call latency over the dataset run (ms). 0 when unknown. */
  latencyMs: number;
  /** The triage benchmark score (carries .pass + .score + .failReasons). */
  triage: TriageScore;
}

export interface SelectionInput {
  candidates: CandidateAssessment[];
  /** The current security_scan default model id (DEFAULT_MODEL). */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
}

export interface RejectedCandidate {
  modelId: string;
  reason: string;
}

export interface SelectionResult {
  /** The model the benchmark recommends as the security_scan default. */
  recommendedModelId: string;
  /** True iff the recommendation differs from the incumbent. */
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: CandidateAssessment[];
  /** Candidates that failed one of the gates, with the reason. */
  rejected: RejectedCandidate[];
}

/** Is `candidate` NOT pricier than the incumbent on either axis? */
function notPricier(
  candidate: CandidateAssessment,
  inInc: number,
  outInc: number,
): boolean {
  return (
    candidate.inputDollarsPerMillion <= inInc + COST_EPSILON &&
    candidate.outputDollarsPerMillion <= outInc + COST_EPSILON
  );
}

/**
 * Apply the three gates and pick the winner. Deterministic, pure.
 *
 * If no eligible same-or-cheaper passer exists, the incumbent is kept
 * (changed=false) — the benchmark NEVER recommends a pricier model and never
 * leaves the tool without a default.
 */
export function selectSecurityTriageModel(input: SelectionInput): SelectionResult {
  const { incumbentModelId, incumbentInputDollarsPerMillion: inInc, incumbentOutputDollarsPerMillion: outInc } = input;

  const eligible: CandidateAssessment[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const c of input.candidates) {
    if (!c.qualified) {
      rejected.push({
        modelId: c.modelId,
        reason: `does not meet security-triage requirements${c.disqualifyReason ? ` (${c.disqualifyReason})` : ""}`,
      });
      continue;
    }
    if (!c.triage.pass) {
      rejected.push({
        modelId: c.modelId,
        reason: `failed the triage benchmark: ${c.triage.failReasons.join("; ")}`,
      });
      continue;
    }
    if (!notPricier(c, inInc, outInc)) {
      rejected.push({
        modelId: c.modelId,
        reason: `pricier than the incumbent default (in $${c.inputDollarsPerMillion.toFixed(3)}/out $${c.outputDollarsPerMillion.toFixed(3)} vs incumbent in $${inInc.toFixed(3)}/out $${outInc.toFixed(3)}) — never auto-bump to a pricier model`,
      });
      continue;
    }
    eligible.push(c);
  }

  eligible.sort((a, b) => {
    if (b.triage.score !== a.triage.score) return b.triage.score - a.triage.score;
    const aCost = a.inputDollarsPerMillion + a.outputDollarsPerMillion;
    const bCost = b.inputDollarsPerMillion + b.outputDollarsPerMillion;
    if (aCost !== bCost) return aCost - bCost;
    return a.latencyMs - b.latencyMs;
  });

  if (eligible.length === 0) {
    return {
      recommendedModelId: incumbentModelId,
      changed: false,
      reason:
        "No eligible same-or-cheaper model passed the triage benchmark. Keeping the incumbent default.",
      eligible,
      rejected,
    };
  }

  const winner = eligible[0];
  const changed = winner.modelId !== incumbentModelId;
  return {
    recommendedModelId: winner.modelId,
    changed,
    reason: changed
      ? `${winner.modelId} passed the triage benchmark (score ${winner.triage.score.toFixed(3)}) at no higher cost than the incumbent and scored best among eligible passers.`
      : `The incumbent ${winner.modelId} remains the best eligible passer (score ${winner.triage.score.toFixed(3)}).`,
    eligible,
    rejected,
  };
}
