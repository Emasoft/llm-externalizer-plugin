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
import {
  selectSameOrCheaper,
  type GenericCandidate,
} from "../select-common.js";
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

/**
 * Map a triage CandidateAssessment onto the tool-agnostic GenericCandidate the
 * shared gate consumes. The triage SCORE (not pass) is what ranks eligible
 * passers, so it is carried as `benchmarkScore`.
 */
function toGeneric(c: CandidateAssessment): GenericCandidate {
  return {
    modelId: c.modelId,
    qualified: c.qualified,
    disqualifyReason: c.disqualifyReason,
    inputDollarsPerMillion: c.inputDollarsPerMillion,
    outputDollarsPerMillion: c.outputDollarsPerMillion,
    latencyMs: c.latencyMs,
    benchmarkPass: c.triage.pass,
    benchmarkScore: c.triage.score,
    benchmarkFailReasons: c.triage.failReasons,
  };
}

/**
 * Apply the three gates and pick the winner. Deterministic, pure.
 *
 * Delegates to the shared same-or-cheaper gate (select-common.ts), passing the
 * security-triage labels so the rejection / recommendation wording is unchanged
 * ("security-triage requirements" / "the triage benchmark"). The result's
 * `eligible` is mapped back to the original CandidateAssessment objects in the
 * gate's sort order, preserving the public API.
 *
 * If no eligible same-or-cheaper passer exists, the incumbent is kept
 * (changed=false) — the benchmark NEVER recommends a pricier model and never
 * leaves the tool without a default.
 */
export function selectSecurityTriageModel(input: SelectionInput): SelectionResult {
  const byModelId = new Map<string, CandidateAssessment>(
    input.candidates.map((c) => [c.modelId, c]),
  );

  const generic = selectSameOrCheaper({
    candidates: input.candidates.map(toGeneric),
    incumbentModelId: input.incumbentModelId,
    incumbentInputDollarsPerMillion: input.incumbentInputDollarsPerMillion,
    incumbentOutputDollarsPerMillion: input.incumbentOutputDollarsPerMillion,
    requirementsLabel: "security-triage requirements",
    benchmarkLabel: "the triage benchmark",
  });

  return {
    recommendedModelId: generic.recommendedModelId,
    changed: generic.changed,
    reason: generic.reason,
    // Reorder the original assessments by the gate's eligible ordering. Every
    // eligible modelId came from input.candidates, so the lookup never misses.
    eligible: generic.eligible.map((g) => byModelId.get(g.modelId)!),
    rejected: generic.rejected,
  };
}
