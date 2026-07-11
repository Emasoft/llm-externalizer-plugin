/**
 * Selection gate for the check_against_specs model (P2d).
 *
 * Identical posture to the security-triage, search-existing, code-task and scan-folder
 * gates: a candidate may become check_against_specs's default ONLY if it
 *   1. meets check_against_specs's per-tool REQUIREMENTS (carried in `qualified`),
 *   2. PASSES the spec-adherence benchmark (passesThresholds(aggregate).pass —
 *      micro-F1 + recall + coverage floors),
 *   3. is NOT pricier than the incumbent on either axis.
 * Among eligible same-or-cheaper passers, the best micro-F1 wins (ties → cost →
 * latency). The three-gate math lives in select-common.ts; this module only maps the
 * spec-adherence assessment onto the generic candidate and back.
 *
 * CHECK_SPECS_CRITERIA is re-exported FROM the registry descriptor so the requirement
 * numbers live in exactly ONE place (registry.ts) — this module does NOT redeclare them.
 *
 * Pure module — no network, no IO. Fully unit-testable.
 */

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import type { ModelCriteria } from "../discover.js";
import { selectSameOrCheaper, type GenericCandidate } from "../select-common.js";
import { passesThresholds, type CheckSpecsScore } from "./score.js";

/**
 * Per-tool requirements for check_against_specs. Single source of truth is the registry
 * descriptor — re-exported here so callers importing from the selector get the SAME
 * object, never a divergent copy.
 */
export const CHECK_SPECS_CRITERIA: ModelCriteria =
  TOOL_MODEL_REGISTRY.check_against_specs.requirements;

export interface CheckSpecsCandidate {
  modelId: string;
  /** Passed qualify() against CHECK_SPECS_CRITERIA. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-file-call latency over the corpus run (ms). 0 when unknown. */
  latencyMs: number;
  /** The deterministic benchmark aggregate (carries micro-F1 / recall / coverage). */
  score: CheckSpecsScore;
}

export interface CheckSpecsSelectionInput {
  candidates: CheckSpecsCandidate[];
  /** The current check_against_specs default model id. */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
}

export interface CheckSpecsRejectedCandidate {
  modelId: string;
  reason: string;
}

export interface CheckSpecsSelectionResult {
  recommendedModelId: string;
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: CheckSpecsCandidate[];
  rejected: CheckSpecsRejectedCandidate[];
}

/**
 * Map a spec-adherence candidate onto the tool-agnostic GenericCandidate. The ranking
 * score is MICRO-F1, for the same reason scan_folder and search_existing rank on it: the
 * corpus is ONE case (one spec, thirteen files) and the atom of work is one FILE verdict,
 * so pooling the per-file confusion counts is the only weighting that means anything.
 * (Macro-F1 across cases is what code_task ranks on, because its cases are whole audit
 * jobs of wildly different sizes; here there is a single case, so macro and micro would
 * coincide anyway and micro is the honest name for it.)
 */
function toGeneric(c: CheckSpecsCandidate): GenericCandidate {
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
 * Delegates to the shared same-or-cheaper gate with the check-specs labels. If no
 * eligible same-or-cheaper passer exists the incumbent is kept (changed=false) — the gate
 * NEVER recommends a pricier model and never leaves the tool without a default.
 */
export function selectCheckSpecsModel(
  input: CheckSpecsSelectionInput,
): CheckSpecsSelectionResult {
  const byModelId = new Map<string, CheckSpecsCandidate>(
    input.candidates.map((c) => [c.modelId, c]),
  );

  const generic = selectSameOrCheaper({
    candidates: input.candidates.map(toGeneric),
    incumbentModelId: input.incumbentModelId,
    incumbentInputDollarsPerMillion: input.incumbentInputDollarsPerMillion,
    incumbentOutputDollarsPerMillion: input.incumbentOutputDollarsPerMillion,
    requirementsLabel: "check-against-specs requirements",
    benchmarkLabel: "the spec-adherence benchmark",
  });

  return {
    recommendedModelId: generic.recommendedModelId,
    changed: generic.changed,
    reason: generic.reason,
    eligible: generic.eligible.map((g) => byModelId.get(g.modelId)!),
    rejected: generic.rejected,
  };
}
