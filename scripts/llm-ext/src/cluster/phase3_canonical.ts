// Phase 3 of cluster_synonyms (TRDD-220ea89f §7 Phase 3). After Phase
// 1+2 we have a stable partition; Phase 3 picks one canonical
// sentence per cluster. Two modes:
//
//   - "heuristic": shortest non-empty sentence, ties broken lex. No LLM
//     calls. Implemented inline in the orchestrator (pickHeuristicCanonical).
//
//   - "llm": for clusters of size > 1, ONE LLM call per cluster asking
//     for the cleanest canonical from the cluster's members. Singletons
//     bypass the LLM (no choice to make). The returned canonical MUST
//     be one of the input sentences — otherwise the LLM hallucinated
//     a new label, which the prompt explicitly forbids; on validation
//     failure the heuristic answer is kept and a warning is emitted.

import { z } from "zod";
import {
  processBatchWithRetry,
  type LlmCallFn,
  type RetryBudget,
  type ValidateFn,
} from "./retry_ladder.js";
import type { Phase1RawLlmCall } from "./phase1_batch.js";
import type { ClusterPolicy } from "./types.js";

export const Phase3ResponseSchema = z.object({
  canonical: z.string().min(1),
  rationale: z.string(),
});
export type Phase3Response = z.infer<typeof Phase3ResponseSchema>;

const PHASE3_PROMPT_HEADER = [
  "Given these synonymous sentences/labels (all conveying the same overall meaning), pick the",
  "single CLEANEST canonical form. Prefer: short (3-50 chars when possible), no trailing",
  "punctuation, no version numbers, no abbreviations, complete enough to stand alone.",
  "If multiple are equally good, pick the first listed.",
  "",
].join("\n");

const PHASE3_PROMPT_FOOTER = [
  "",
  'Output: a JSON object {"canonical": "...", "rationale": "..."}.',
  "The canonical MUST be one of the input sentences verbatim — do not invent new wording.",
].join("\n");

/** Build the Phase 3 prompt for one cluster. Pass-by-id is unnecessary
 *  here — there's only one decision per call and the answer is the
 *  string itself, not an id. */
export function buildPhase3Prompt(sentences: string[]): string {
  const lines = sentences.map((s) => `- ${s.replace(/\r?\n/g, " ")}`).join("\n");
  return `${PHASE3_PROMPT_HEADER}\nSentences:\n${lines}\n${PHASE3_PROMPT_FOOTER}`;
}

/** Pick the heuristic canonical: shortest non-empty sentence, ties
 *  broken by lex order. Exported so the orchestrator + Phase 3 LLM
 *  fallback share the same logic. */
export function pickHeuristicCanonical(sentences: readonly string[]): string {
  if (sentences.length === 0) return "";
  let best = sentences[0];
  for (let i = 1; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.length < best.length || (s.length === best.length && s < best)) best = s;
  }
  return best;
}

export interface Phase3Inputs {
  /** Each entry is one cluster: id → list of member sentences. */
  clusters: Array<{ clusterId: string; sentences: string[] }>;
  policy: ClusterPolicy;
  budget: RetryBudget;
}

export interface Phase3Result {
  /** clusterId → canonical sentence (heuristic for singletons + fallback). */
  canonicals: Map<string, string>;
  /** Clusters where the LLM hallucinated or failed — heuristic kept,
   *  warning emitted. */
  warnings: string[];
  llmCallCount: number;
  budgetExhausted: boolean;
}

/** Run Phase 3 in LLM mode. Singletons + 2-item clusters with both
 *  sentences identical bypass the LLM (no real choice). Each remaining
 *  cluster gets exactly one LLM call; budget tracked via the shared
 *  retry-ladder budget object. On validation failure (parse error,
 *  schema error, OR canonical-not-in-input) we keep the heuristic and
 *  emit a warning. */
export async function runPhase3Llm(
  inputs: Phase3Inputs,
  rawLlmCall: Phase1RawLlmCall,
): Promise<Phase3Result> {
  const { clusters, policy, budget } = inputs;
  const canonicals = new Map<string, string>();
  const warnings: string[] = [];
  let llmCallCount = 0;
  let budgetExhausted = false;

  for (const { clusterId, sentences } of clusters) {
    if (sentences.length === 0) {
      canonicals.set(clusterId, "");
      continue;
    }
    // Singletons / all-identical clusters: heuristic answer is exact.
    const distinct = Array.from(new Set(sentences));
    if (distinct.length <= 1) {
      canonicals.set(clusterId, distinct[0] ?? "");
      continue;
    }
    if (budgetExhausted) {
      // Budget already exhausted on a prior cluster — every remaining
      // cluster gets the heuristic answer with no further LLM calls.
      canonicals.set(clusterId, pickHeuristicCanonical(distinct));
      continue;
    }

    const sentencesArr = distinct;
    const heuristic = pickHeuristicCanonical(sentencesArr);

    const llmCall: LlmCallFn<string, Phase3Response> = async (items) => {
      const prompt = buildPhase3Prompt(items);
      const raw = await rawLlmCall(prompt);
      const parsed = JSON.parse(raw);
      return Phase3ResponseSchema.parse(parsed);
    };

    const allowed = new Set(sentencesArr);
    const validate: ValidateFn<string, Phase3Response> = (response) => {
      if (!allowed.has(response.canonical)) {
        return {
          ok: false,
          reason: `canonical '${response.canonical.slice(0, 60)}' is not one of the input sentences`,
        };
      }
      return { ok: true };
    };

    const result = await processBatchWithRetry(
      sentencesArr,
      llmCall,
      validate,
      {
        // One LLM call per cluster is enough — splitting a Phase 3 batch
        // doesn't help here (each cluster is independent). Set
        // maxSplitDepth to 0 so a hallucinating response just falls
        // through to the heuristic without recursive subdivision.
        maxRetriesPerAttempt: policy.max_retries_per_attempt,
        maxSplitDepth: 0,
      },
      budget,
    );
    llmCallCount += result.llmCallCount;
    if (result.budgetExhausted) budgetExhausted = true;

    if (result.succeeded.length > 0) {
      canonicals.set(clusterId, result.succeeded[0].response.canonical);
    } else {
      const last = result.failed[0];
      canonicals.set(clusterId, heuristic);
      warnings.push(
        `phase3: cluster ${clusterId} LLM canonical failed (${last?.lastError ?? "no detail"}), ` +
          `falling back to heuristic '${heuristic.slice(0, 60)}'`,
      );
    }
  }

  return { canonicals, warnings, llmCallCount, budgetExhausted };
}
