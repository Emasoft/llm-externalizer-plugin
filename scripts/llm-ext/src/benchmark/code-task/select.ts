/**
 * Selection gate for the code_task model (P2b).
 *
 * Identical posture to the security-triage and search-existing gates: a
 * candidate may become code_task's default ONLY if it
 *   1. meets code_task's per-tool REQUIREMENTS (carried in `qualified`),
 *   2. PASSES the code-audit benchmark (passesThresholds(aggregate).pass —
 *      macro-F1 + recall floors + the failed-case ceiling),
 *   3. is NOT pricier than the incumbent on either axis.
 * Among eligible same-or-cheaper passers, the best macro-F1 wins (ties → cost →
 * latency). The three-gate math lives in select-common.ts; this module only maps
 * the code-audit assessment onto the generic candidate and back.
 *
 * CODE_TASK_CRITERIA is re-exported FROM the registry descriptor so the
 * requirement numbers live in exactly ONE place (registry.ts) — this module does
 * NOT redeclare them.
 *
 * Pure module — no network, no IO. Fully unit-testable.
 */

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import type { ModelCriteria } from "../discover.js";
import { selectSameOrCheaper, type GenericCandidate } from "../select-common.js";
import { passesThresholds, type CodeAuditScore } from "./score.js";

/**
 * Per-tool requirements for code_task. Single source of truth is the registry
 * descriptor — re-exported here so callers importing from the selector get the
 * SAME object, never a divergent copy.
 */
export const CODE_TASK_CRITERIA: ModelCriteria = TOOL_MODEL_REGISTRY.code_task.requirements;

export interface CodeTaskCandidate {
  modelId: string;
  /** Passed qualify() against CODE_TASK_CRITERIA. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-call latency over the dataset run (ms). 0 when unknown. */
  latencyMs: number;
  /** The deterministic benchmark aggregate (carries macro-F1 / recall / failures). */
  score: CodeAuditScore;
}

export interface CodeTaskSelectionInput {
  candidates: CodeTaskCandidate[];
  /** The current code_task default model id. */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
}

export interface CodeTaskRejectedCandidate {
  modelId: string;
  reason: string;
}

export interface CodeTaskSelectionResult {
  recommendedModelId: string;
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: CodeTaskCandidate[];
  rejected: CodeTaskRejectedCandidate[];
}

/**
 * Map a code-audit candidate onto the tool-agnostic GenericCandidate. The
 * ranking score is macro-F1 (the mean per-case localization F1) — NOT micro-F1:
 * the fixtures differ wildly in size (4 KB → 34 KB) and in truth-set size (0 → 2
 * symbols), so micro-pooling would let one big case dominate the ranking. Every
 * case is one code-audit job and counts once.
 */
function toGeneric(c: CodeTaskCandidate): GenericCandidate {
  const thr = passesThresholds(c.score);
  return {
    modelId: c.modelId,
    qualified: c.qualified,
    disqualifyReason: c.disqualifyReason,
    inputDollarsPerMillion: c.inputDollarsPerMillion,
    outputDollarsPerMillion: c.outputDollarsPerMillion,
    latencyMs: c.latencyMs,
    benchmarkPass: thr.pass,
    benchmarkScore: c.score.macroF1,
    benchmarkFailReasons: thr.failures,
  };
}

/**
 * Apply the three gates and pick the winner. Deterministic, pure.
 *
 * Delegates to the shared same-or-cheaper gate with the code-task labels. If no
 * eligible same-or-cheaper passer exists the incumbent is kept (changed=false) —
 * the gate NEVER recommends a pricier model and never leaves the tool without a
 * default.
 */
export function selectCodeTaskModel(input: CodeTaskSelectionInput): CodeTaskSelectionResult {
  const byModelId = new Map<string, CodeTaskCandidate>(
    input.candidates.map((c) => [c.modelId, c]),
  );

  const generic = selectSameOrCheaper({
    candidates: input.candidates.map(toGeneric),
    incumbentModelId: input.incumbentModelId,
    incumbentInputDollarsPerMillion: input.incumbentInputDollarsPerMillion,
    incumbentOutputDollarsPerMillion: input.incumbentOutputDollarsPerMillion,
    requirementsLabel: "code-task requirements",
    benchmarkLabel: "the code-audit benchmark",
  });

  return {
    recommendedModelId: generic.recommendedModelId,
    changed: generic.changed,
    reason: generic.reason,
    eligible: generic.eligible.map((g) => byModelId.get(g.modelId)!),
    rejected: generic.rejected,
  };
}
