/**
 * Selection gate for the four text-tool models (summarize / topics /
 * sem_deduplicate / describe). Identical posture to every other per-tool
 * gate (code-task/select.ts, check-specs/select.ts, ...): a candidate may
 * become a tool's default ONLY if it
 *   1. meets that tool's per-tool REQUIREMENTS (carried in `qualified`),
 *   2. PASSES that tool's text-tool benchmark (passesTextToolThresholds —
 *      a mean concept-score floor + a failed-case ceiling),
 *   3. is NOT pricier than the incumbent on either axis.
 * Among eligible same-or-cheaper passers, the best mean score wins (ties →
 * cost → latency). The three-gate math lives in select-common.ts; this
 * module only maps each text-tool assessment onto the generic candidate and
 * back — ONE selector shared by all four tools (their score shape,
 * TextToolScore, is identical), parameterized by `tool` for the labels.
 *
 * Per-tool REQUIREMENTS are re-exported FROM the registry descriptor so the
 * requirement numbers live in exactly ONE place (registry.ts) — this module
 * does not redeclare them.
 *
 * Pure module — no network, no IO. Fully unit-testable.
 */

import { TOOL_MODEL_REGISTRY } from "../../model-qualification/registry.js";
import type { ModelCriteria } from "../discover.js";
import { selectSameOrCheaper, type GenericCandidate } from "../select-common.js";
import { passesTextToolThresholds, type TextToolScore } from "./score.js";
import type { TextToolName } from "./bench-runner.js";

/** Per-tool requirements, read from the single source of truth (registry.ts). */
export function textToolCriteria(tool: TextToolName): ModelCriteria {
  return TOOL_MODEL_REGISTRY[tool].requirements;
}

export interface TextToolCandidate {
  modelId: string;
  /** Passed qualify() against the tool's registry requirements. */
  qualified: boolean;
  /** Why it failed qualify (when qualified === false). */
  disqualifyReason?: string;
  inputDollarsPerMillion: number;
  outputDollarsPerMillion: number;
  /** Mean per-call latency over the dataset run (ms). 0 when unknown. */
  latencyMs: number;
  /** The deterministic benchmark aggregate (mean concept score + failures). */
  score: TextToolScore;
}

export interface TextToolSelectionInput {
  candidates: TextToolCandidate[];
  /** The current default model id for this tool. */
  incumbentModelId: string;
  incumbentInputDollarsPerMillion: number;
  incumbentOutputDollarsPerMillion: number;
}

export interface TextToolRejectedCandidate {
  modelId: string;
  reason: string;
}

export interface TextToolSelectionResult {
  recommendedModelId: string;
  changed: boolean;
  reason: string;
  /** Eligible passers (qualified + benchmark-pass + not-pricier), best-first. */
  eligible: TextToolCandidate[];
  rejected: TextToolRejectedCandidate[];
}

function toGeneric(c: TextToolCandidate): GenericCandidate {
  const thr = passesTextToolThresholds(c.score);
  return {
    modelId: c.modelId,
    qualified: c.qualified,
    disqualifyReason: c.disqualifyReason,
    inputDollarsPerMillion: c.inputDollarsPerMillion,
    outputDollarsPerMillion: c.outputDollarsPerMillion,
    latencyMs: c.latencyMs,
    benchmarkPass: thr.pass,
    benchmarkScore: c.score.meanScore,
    benchmarkFailReasons: [thr.reason],
  };
}

/** Apply the three gates and pick the winner. Deterministic, pure. */
export function selectTextToolModel(
  tool: TextToolName,
  input: TextToolSelectionInput,
): TextToolSelectionResult {
  const byModelId = new Map<string, TextToolCandidate>(input.candidates.map((c) => [c.modelId, c]));

  const generic = selectSameOrCheaper({
    candidates: input.candidates.map(toGeneric),
    incumbentModelId: input.incumbentModelId,
    incumbentInputDollarsPerMillion: input.incumbentInputDollarsPerMillion,
    incumbentOutputDollarsPerMillion: input.incumbentOutputDollarsPerMillion,
    requirementsLabel: `${tool} requirements`,
    benchmarkLabel: `the ${tool} benchmark`,
  });

  return {
    recommendedModelId: generic.recommendedModelId,
    changed: generic.changed,
    reason: generic.reason,
    eligible: generic.eligible.map((g) => byModelId.get(g.modelId)!),
    rejected: generic.rejected,
  };
}
