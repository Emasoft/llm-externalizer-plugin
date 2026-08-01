// Phase 1 of cluster_synonyms (TRDD-220ea89f §6 Phase B). For each
// k-means cluster (or random partition when embeddings are absent —
// T6), build a batch of <= policy.batch_size items, dispatch through
// the recursive-split-and-retry ladder, and emit pairwise union-find
// edges from each LLM-returned group. Per-batch numeric ids (1..K)
// are used in the prompt and mapped back to the input items' string
// ids server-side, so the LLM never sees raw ClusterInputItem.id
// values (insulates the prompt from id-formatting / collision issues).

import { z } from "zod";
import { kmeans } from "./kmeans.js";
import {
  processBatchWithRetry,
  type LlmCallFn,
  type RetryBudget,
  type ValidateFn,
  type ValidateResult,
} from "./retry_ladder.js";
import type { ClusterInputItem, ClusterPolicy, FailedGroup } from "./types.js";

export const Phase1ResponseSchema = z.object({
  groups: z.array(z.array(z.number().int().positive())),
});
export type Phase1Response = z.infer<typeof Phase1ResponseSchema>;

/** Bare LLM transport: prompt in, raw text out. Caller wires this to
 *  the existing `processBatch`/`callLLM` plumbing in index.ts. */
export type Phase1RawLlmCall = (prompt: string) => Promise<string>;

export interface Phase1Inputs {
  items: ClusterInputItem[];
  /** Optional flat float32 buffer of length items.length × dim. When
   *  omitted (or policy.compute_embeddings === false) Phase 1 falls
   *  back to random batching — T6 in §5 of the TRDD. */
  embeddings?: Float32Array;
  dim?: number;
  policy: ClusterPolicy;
  budget: RetryBudget;
  /** Deterministic shuffle seed for the random-batching fallback. */
  seed?: number;
}

export interface Phase1Edge {
  /** Pairwise edge between two ClusterInputItem.id strings — caller
   *  feeds these straight into UnionFind.union(). */
  a: string;
  b: string;
}

export interface Phase1Result {
  edges: Phase1Edge[];
  failed: FailedGroup[];
  llmCallCount: number;
  batchesAttempted: number;
  batchesSucceeded: number;
  budgetExhausted: boolean;
  warnings: string[];
}

const PHASE1_PROMPT_HEADER = [
  "You are given N short SENTENCES (or short labels treated as sentences), each with a numeric id",
  "and a context hint (optional). Group sentences that have IDENTICAL or NEARLY-IDENTICAL",
  "overall meaning. Slight wording differences are OK; sentences that convey DIFFERENT concepts",
  "must NEVER be grouped together. You are NOT doing word-by-word synonym matching — you are",
  "comparing whole-sentence meaning. Examples:",
  "",
  '  "Compile the code with optimizations" ≡ "Build the project with optimizer flags"   → same group',
  '  "Compile the code"                    ≠ "Test the code"                            → different groups',
  '  "domain/programming/"                 ≡ "domain/coding/"                           → same group',
  '  "domain/programming/"                 ≠ "domain/testing/"                          → different groups',
  "",
  'Output: a JSON object {"groups": [[id, id, ...], [id], ...]}.',
  "Every input id MUST appear exactly once across all groups.",
  "Singletons stay as 1-element groups.",
].join("\n");

function escapeQuoted(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function buildPhase1Prompt(items: ClusterInputItem[]): string {
  const lines: string[] = ["", "Sentences:"];
  for (let i = 0; i < items.length; i++) {
    const numId = i + 1;
    const it = items[i];
    const ctx = it.context && it.context.length > 0
      ? `  ctx="${escapeQuoted(it.context)}"`
      : "";
    lines.push(`${numId}. id=${numId}  sentence="${escapeQuoted(it.sentence)}"${ctx}`);
  }
  return `${PHASE1_PROMPT_HEADER}\n${lines.join("\n")}\n`;
}

/** Strict semantic check: every per-batch numeric id appears exactly
 *  once across all groups, no aliens, no duplicates. */
export function validatePhase1Response(
  response: Phase1Response,
  expectedSize: number,
): ValidateResult {
  const seen = new Set<number>();
  for (const group of response.groups) {
    if (group.length === 0) {
      return { ok: false, reason: "empty group in response" };
    }
    for (const id of group) {
      if (id < 1 || id > expectedSize) {
        return { ok: false, reason: `id ${id} out of range 1..${expectedSize}` };
      }
      if (seen.has(id)) {
        return { ok: false, reason: `id ${id} appears in multiple groups` };
      }
      seen.add(id);
    }
  }
  if (seen.size !== expectedSize) {
    const missing: number[] = [];
    for (let i = 1; i <= expectedSize; i++) {
      if (!seen.has(i)) missing.push(i);
    }
    return { ok: false, reason: `missing ids: ${missing.slice(0, 10).join(",")}${missing.length > 10 ? "..." : ""}` };
  }
  return { ok: true };
}

// Mulberry32 — same deterministic PRNG used by kmeans.ts.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleIndices(n: number, seed: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  const rng = makeRng(seed);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx;
}

function batchesFromKMeans(
  items: ClusterInputItem[],
  embeddings: Float32Array,
  dim: number,
  batchSize: number,
  seed: number,
): ClusterInputItem[][] {
  const N = items.length;
  if (N === 0) return [];
  const K = Math.max(1, Math.ceil(N / batchSize));
  // Slice the flat float32 buffer into N per-item views (no copy).
  const vectors: Float32Array[] = new Array(N);
  for (let i = 0; i < N; i++) {
    vectors[i] = embeddings.subarray(i * dim, (i + 1) * dim);
  }
  const { assignments } = kmeans(vectors, K, { seed });
  const buckets: ClusterInputItem[][] = Array.from({ length: K }, () => []);
  for (let i = 0; i < N; i++) {
    buckets[assignments[i]].push(items[i]);
  }
  // Bucket sizes are uneven; split any bucket > batchSize into FFD-style
  // slices of size <= batchSize so the LLM never sees > batch_size items.
  const out: ClusterInputItem[][] = [];
  for (const bucket of buckets) {
    if (bucket.length === 0) continue;
    if (bucket.length <= batchSize) {
      out.push(bucket);
      continue;
    }
    for (let off = 0; off < bucket.length; off += batchSize) {
      out.push(bucket.slice(off, off + batchSize));
    }
  }
  return out;
}

function batchesFromRandom(
  items: ClusterInputItem[],
  batchSize: number,
  seed: number,
): ClusterInputItem[][] {
  const idx = shuffleIndices(items.length, seed);
  const out: ClusterInputItem[][] = [];
  for (let off = 0; off < idx.length; off += batchSize) {
    const slice = idx.slice(off, off + batchSize);
    out.push(slice.map((i) => items[i]));
  }
  return out;
}

export function planPhase1Batches(inputs: Phase1Inputs): {
  batches: ClusterInputItem[][];
  warnings: string[];
} {
  const { items, embeddings, dim, policy, seed = 42 } = inputs;
  const warnings: string[] = [];
  if (items.length === 0) return { batches: [], warnings };
  const useEmbeddings =
    policy.compute_embeddings &&
    embeddings !== undefined &&
    dim !== undefined &&
    dim > 0 &&
    embeddings.length === items.length * dim;
  if (!useEmbeddings) {
    if (policy.compute_embeddings) {
      warnings.push(
        "phase1: compute_embeddings=true but no usable embeddings supplied — falling back to random batching",
      );
    } else {
      warnings.push("phase1: random batching (compute_embeddings=false)");
    }
    return { batches: batchesFromRandom(items, policy.batch_size, seed), warnings };
  }
  return {
    batches: batchesFromKMeans(items, embeddings!, dim!, policy.batch_size, seed),
    warnings,
  };
}

export async function runPhase1(
  inputs: Phase1Inputs,
  rawLlmCall: Phase1RawLlmCall,
): Promise<Phase1Result> {
  const { policy, budget } = inputs;
  const { batches, warnings } = planPhase1Batches(inputs);

  const edges: Phase1Edge[] = [];
  const failed: FailedGroup[] = [];
  let llmCallCount = 0;
  let batchesSucceeded = 0;
  let budgetExhausted = false;

  for (const batch of batches) {
    const llmCall: LlmCallFn<ClusterInputItem, Phase1Response> = async (slice) => {
      const prompt = buildPhase1Prompt(slice);
      const raw = await rawLlmCall(prompt);
      const parsed = JSON.parse(raw);
      return Phase1ResponseSchema.parse(parsed);
    };

    // Validator sees the slice the ladder is currently processing (NOT
    // the original source batch) — so after a split, validation expects
    // sub-batch.length ids, not the parent batch's length.
    const validate: ValidateFn<ClusterInputItem, Phase1Response> = (response, slice) =>
      validatePhase1Response(response, slice.length);

    const result = await processBatchWithRetry(
      batch,
      llmCall,
      validate,
      {
        maxRetriesPerAttempt: policy.max_retries_per_attempt,
        maxSplitDepth: policy.max_split_depth,
      },
      budget,
    );

    llmCallCount += result.llmCallCount;
    if (result.budgetExhausted) budgetExhausted = true;

    for (const leaf of result.succeeded) {
      batchesSucceeded += 1;
      for (const group of leaf.response.groups) {
        if (group.length < 2) continue;
        const anchorIdx = group[0] - 1;
        const anchor = leaf.items[anchorIdx];
        if (!anchor) continue;
        for (let g = 1; g < group.length; g++) {
          const otherIdx = group[g] - 1;
          const other = leaf.items[otherIdx];
          if (!other) continue;
          edges.push({ a: anchor.id, b: other.id });
        }
      }
    }

    for (const leaf of result.failed) {
      failed.push({
        depth: leaf.depth,
        attempt_count: leaf.attempts,
        item_ids: leaf.items.map((it) => it.id),
        last_error: leaf.lastError,
      });
    }

    if (budgetExhausted) break;
  }

  return {
    edges,
    failed,
    llmCallCount,
    batchesAttempted: batches.length,
    batchesSucceeded,
    budgetExhausted,
    warnings,
  };
}
