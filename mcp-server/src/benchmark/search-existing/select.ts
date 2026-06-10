/**
 * Selection gate for the search_existing_implementations model (TRDD-828238b5 A6).
 *
 * Identical posture to the security_scan triage gate, but for the
 * duplicate-implementation tool: a candidate may become the default ONLY if it
 *   1. meets search_existing's per-tool REQUIREMENTS (carried in `qualified`),
 *   2. PASSES the search-existing fixture benchmark
 *      (passesThresholds(aggregate).pass — micro-F1 + recall + coverage floors),
 *   3. is NOT pricier than the incumbent on either axis.
 * Among eligible same-or-cheaper passers, the best micro-F1 wins (ties → cost →
 * latency). The three-gate math lives in select-common.ts; this module maps the
 * search-existing assessment onto the generic candidate and back.
 *
 * SEARCH_EXISTING_CRITERIA is re-exported FROM the registry's descriptor so the
 * requirement numbers live in exactly one place (registry.ts) — this module
 * does NOT redeclare them.
 *
 * Pure module — no network, no IO. Fully unit-testable.
 */

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import type { ModelCriteria } from "../discover.js";
import {
  selectSameOrCheaper,
  type GenericCandidate,
} from "../select-common.js";
import { passesThresholds, type SearchExistingScore } from "./score.js";

/**
 * Per-tool requirements for search_existing_implementations. Single source of
 * truth is the registry descriptor (registry.ts) — re-exported here so callers
 * importing from the selector get the SAME object, never a divergent copy.
 */
export const SEARCH_EXISTING_CRITERIA: ModelCriteria =
  TOOL_MODEL_REGISTRY.search_existing_implementations.requirements;

export interface SearchExistingCandidate {
  modelId: string;
  /** Passed qualify() against SEARCH_EXISTING_CRITERIA. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-call latency over the dataset run (ms). 0 when unknown. */
  latencyMs: number;
  /** The deterministic benchmark aggregate (carries micro-F1 / recall / coverage). */
  score: SearchExistingScore;
}

export interface SearchExistingSelectionInput {
  candidates: SearchExistingCandidate[];
  /** The current search_existing_implementations default model id. */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
}

export interface SearchExistingRejectedCandidate {
  modelId: string;
  reason: string;
}

export interface SearchExistingSelectionResult {
  recommendedModelId: string;
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: SearchExistingCandidate[];
  rejected: SearchExistingRejectedCandidate[];
}

/**
 * Map a search-existing candidate onto the tool-agnostic GenericCandidate. The
 * ranking score is the aggregate micro-F1; pass + failReasons come from
 * passesThresholds (the same gate the benchmark uses to decide pass).
 */
function toGeneric(c: SearchExistingCandidate): GenericCandidate {
  const thr = passesThresholds(c.score);
  return {
    modelId: c.modelId,
    qualified: c.qualified,
    disqualifyReason: c.disqualifyReason,
    inputDollarsPerMillion: c.inputDollarsPerMillion,
    outputDollarsPerMillion: c.outputDollarsPerMillion,
    latencyMs: c.latencyMs,
    benchmarkPass: thr.pass,
    benchmarkScore: c.score.microF1,
    benchmarkFailReasons: thr.failures,
  };
}

/**
 * Apply the three gates and pick the winner. Deterministic, pure.
 *
 * Delegates to the shared same-or-cheaper gate with the search-existing labels
 * ("search-existing requirements" / "the search-existing benchmark"). The
 * result's `eligible` is mapped back to the original candidate objects in the
 * gate's sort order.
 */
export function selectSearchExistingModel(
  input: SearchExistingSelectionInput,
): SearchExistingSelectionResult {
  const byModelId = new Map<string, SearchExistingCandidate>(
    input.candidates.map((c) => [c.modelId, c]),
  );

  const generic = selectSameOrCheaper({
    candidates: input.candidates.map(toGeneric),
    incumbentModelId: input.incumbentModelId,
    incumbentInputDollarsPerMillion: input.incumbentInputDollarsPerMillion,
    incumbentOutputDollarsPerMillion: input.incumbentOutputDollarsPerMillion,
    requirementsLabel: "search-existing requirements",
    benchmarkLabel: "the search-existing benchmark",
  });

  return {
    recommendedModelId: generic.recommendedModelId,
    changed: generic.changed,
    reason: generic.reason,
    eligible: generic.eligible.map((g) => byModelId.get(g.modelId)!),
    rejected: generic.rejected,
  };
}
