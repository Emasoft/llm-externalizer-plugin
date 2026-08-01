/**
 * Selection gate for the scan_folder model (P2c).
 *
 * Identical posture to the security-triage, search-existing and code-task gates: a
 * candidate may become scan_folder's default ONLY if it
 *   1. meets scan_folder's per-tool REQUIREMENTS (carried in `qualified`),
 *   2. PASSES the mass-search benchmark (passesThresholds(aggregate).pass —
 *      micro-F1 + recall + coverage floors),
 *   3. is NOT pricier than the incumbent on either axis.
 * Among eligible same-or-cheaper passers, the best micro-F1 wins (ties → cost →
 * latency). The three-gate math lives in select-common.ts; this module only maps
 * the mass-search assessment onto the generic candidate and back.
 *
 * SCAN_FOLDER_CRITERIA is re-exported FROM the registry descriptor so the
 * requirement numbers live in exactly ONE place (registry.ts) — this module does
 * NOT redeclare them.
 *
 * Pure module — no network, no IO. Fully unit-testable.
 */

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import type { ModelCriteria } from "../discover.js";
import { selectSameOrCheaper, type GenericCandidate } from "../select-common.js";
import { passesThresholds, type ScanFolderScore } from "./score.js";

/**
 * Per-tool requirements for scan_folder. Single source of truth is the registry
 * descriptor — re-exported here so callers importing from the selector get the
 * SAME object, never a divergent copy.
 */
export const SCAN_FOLDER_CRITERIA: ModelCriteria = TOOL_MODEL_REGISTRY.scan_folder.requirements;

export interface ScanFolderCandidate {
  modelId: string;
  /** Passed qualify() against SCAN_FOLDER_CRITERIA. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-file-call latency over the corpus run (ms). 0 when unknown. */
  latencyMs: number;
  /** The deterministic benchmark aggregate (carries micro-F1 / recall / coverage). */
  score: ScanFolderScore;
}

export interface ScanFolderSelectionInput {
  candidates: ScanFolderCandidate[];
  /** The current scan_folder default model id. */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
}

export interface ScanFolderRejectedCandidate {
  modelId: string;
  reason: string;
}

export interface ScanFolderSelectionResult {
  recommendedModelId: string;
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: ScanFolderCandidate[];
  rejected: ScanFolderRejectedCandidate[];
}

/**
 * Map a mass-search candidate onto the tool-agnostic GenericCandidate. The ranking
 * score is MICRO-F1 — not macro — and that is the opposite of the code-audit gate's
 * choice, on purpose:
 *   • code-audit's cases differ wildly in size and truth-set size, so micro-pooling
 *     would let one big case dominate; every audit job counts once, hence macro.
 *   • here every case scans the SAME twelve files, and the atom of work is one FILE
 *     decision, not one query. Micro-pooling weights each of the 30 file decisions
 *     equally, which is exactly what a mass search is judged on. Macro would let a
 *     query with 2 positives count as much as one with 6.
 * search_existing's gate ranks on micro-F1 for the same reason (same output shape).
 */
function toGeneric(c: ScanFolderCandidate): GenericCandidate {
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
 * Delegates to the shared same-or-cheaper gate with the scan-folder labels. If no
 * eligible same-or-cheaper passer exists the incumbent is kept (changed=false) —
 * the gate NEVER recommends a pricier model and never leaves the tool without a
 * default.
 */
export function selectScanFolderModel(
  input: ScanFolderSelectionInput,
): ScanFolderSelectionResult {
  const byModelId = new Map<string, ScanFolderCandidate>(
    input.candidates.map((c) => [c.modelId, c]),
  );

  const generic = selectSameOrCheaper({
    candidates: input.candidates.map(toGeneric),
    incumbentModelId: input.incumbentModelId,
    incumbentInputDollarsPerMillion: input.incumbentInputDollarsPerMillion,
    incumbentOutputDollarsPerMillion: input.incumbentOutputDollarsPerMillion,
    requirementsLabel: "scan-folder requirements",
    benchmarkLabel: "the mass-search benchmark",
  });

  return {
    recommendedModelId: generic.recommendedModelId,
    changed: generic.changed,
    reason: generic.reason,
    eligible: generic.eligible.map((g) => byModelId.get(g.modelId)!),
    rejected: generic.rejected,
  };
}
