// Pre-flight in-memory footprint guard for cluster_synonyms (TRDD-828238b5 B3).
//
// WHY this exists: runClusterSynonyms materialises the WHOLE corpus in the JS
// heap several times over — the parsed items[] + itemsById Map, the union-find
// parent/rank maps, the partition Map, and (the dominant cost) the embeddings
// bundle, which is itemCount × dim × 4 bytes of Float32. At ~1M items with the
// default 384-dim all-MiniLM-L6-v2 embeddings that is ~1.5 GB of embeddings
// alone, ~2 GB total — beyond a typical Node old-space heap. Before this guard
// a too-large run OOM-crashed MID-FLIGHT, AFTER the pre-flight benchmark and
// Phase-1/2 LLM budget had already been spent, and the tool's "10k–1M items"
// claim was unbacked (the real default-path ceiling is embeddings-dominated and
// heap-bound, not 1M).
//
// This guard ESTIMATES the footprint from the item count + embedding dimension
// and FAILS FAST with an actionable message when it exceeds a safe fraction of
// THIS process's actual V8 heap limit — so the run aborts before any spend,
// honoring the hard fail-fast rule. The estimate is deliberately CONSERVATIVE
// (slightly over-counts) so the guard trips a little early rather than letting
// an OOM through. The ceiling adapts to --max-old-space-size automatically
// (it is read from V8 at runtime), and policy.skip_memory_guard=true is the
// explicit escape hatch.

import { getHeapStatistics } from "node:v8";
import type { ClusterPolicy } from "./types.js";

/** Per-item heap overhead of EVERYTHING except the embeddings: the parsed
 *  ClusterInputItem (id + sentence strings, UTF-16 + object overhead), the
 *  itemsById Map entry, the union-find parent/rank entries, and the partition
 *  Map membership. These share string references (no duplication), so the real
 *  cost is ~480 B/item on V8; rounded up to 512 for a conservative envelope.
 *  Embeddings are added separately because they dominate at scale. */
export const BASE_BYTES_PER_ITEM = 512;

/** Float32 — 4 bytes per embedding component. The embeddings bundle holds
 *  itemCount × dim of these and passes them to phase1/phase2. */
export const BYTES_PER_EMBEDDING_COMPONENT = 4;

/** Fraction of the V8 heap limit the estimated footprint may occupy. The
 *  remaining ~30% is headroom for JSONL parse buffers, the checkpoint sqlite,
 *  per-batch phase state, and general GC slack. */
export const HEAP_SAFETY_FRACTION = 0.7;

/** Conservative dimension for an embedding model we don't have a known dim
 *  for — over-estimating dim makes the guard trip earlier, which is the safe
 *  direction for a fail-fast budget check. */
export const DEFAULT_EMBEDDING_DIM = 768;

/** Known output dimensions of the sentence-transformer models the tool is
 *  realistically configured with. Unknown models fall back to
 *  DEFAULT_EMBEDDING_DIM. Kept deliberately small — this is a footprint
 *  estimate, NOT a model registry; an off-by-a-bit dim only nudges the
 *  fail-fast threshold, it does not change correctness. */
const KNOWN_EMBEDDING_DIMS: Record<string, number> = {
  "sentence-transformers/all-minilm-l6-v2": 384,
  "sentence-transformers/all-minilm-l12-v2": 384,
  "sentence-transformers/all-mpnet-base-v2": 768,
  "sentence-transformers/paraphrase-multilingual-minilm-l12-v2": 384,
  "baai/bge-small-en-v1.5": 384,
  "baai/bge-base-en-v1.5": 768,
  "baai/bge-large-en-v1.5": 1024,
};

/** Output dim for a model id, case-insensitive; undefined when unknown. */
export function knownEmbeddingDim(model: string): number | undefined {
  return KNOWN_EMBEDDING_DIMS[model.trim().toLowerCase()];
}

/** The embedding dimension that will actually be materialised in the heap:
 *  0 when no embeddings are computed/loaded (random-batching path), else the
 *  known dim for the configured model or the conservative default.
 *
 *  NOTE on the precomputed-file path: when an embeddings_file is supplied its
 *  real dim (from the sibling .meta.json) is authoritative, but reading it here
 *  would couple this pure module to the filesystem and duplicate work
 *  loadEmbeddings already does. We use the configured model's dim (or the
 *  conservative default) as a proxy. This can mis-estimate if the supplied file
 *  was produced by a different model than policy.embedding_model — an advanced,
 *  rare path — but the user who pre-computes their own embeddings can always set
 *  policy.skip_memory_guard=true. */
export function resolveEmbeddingDim(policy: ClusterPolicy, hasEmbeddingsFile: boolean): number {
  if (!hasEmbeddingsFile && !policy.compute_embeddings) return 0;
  return knownEmbeddingDim(policy.embedding_model) ?? DEFAULT_EMBEDDING_DIM;
}

/** Estimated peak JS-heap footprint of a cluster run, in bytes. Pure. */
export function estimateClusterFootprintBytes(itemCount: number, embeddingDim: number): number {
  const n = Math.max(0, itemCount);
  const base = n * BASE_BYTES_PER_ITEM;
  const embeddings = n * Math.max(0, embeddingDim) * BYTES_PER_EMBEDDING_COMPONENT;
  return base + embeddings;
}

/** This process's V8 old-space heap limit in bytes (respects
 *  --max-old-space-size). Impure; injected into checkClusterMemoryBudget for
 *  deterministic tests. */
export function resolveHeapLimitBytes(): number {
  return getHeapStatistics().heap_size_limit;
}

export type MemoryBudgetVerdict = { ok: true } | { ok: false; reason: string };

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export interface MemoryBudgetInput {
  itemCount: number;
  policy: ClusterPolicy;
  hasEmbeddingsFile: boolean;
  /** Injected for tests; defaults to the live V8 heap limit. */
  heapLimitBytes?: number;
}

/** Fail-fast pre-flight check. Returns ok unless the estimated footprint
 *  exceeds HEAP_SAFETY_FRACTION of the heap limit (and the guard isn't
 *  disabled). The reason is actionable: it names the offending numbers and the
 *  concrete ways to proceed. Pure when heapLimitBytes is supplied. */
export function checkClusterMemoryBudget(input: MemoryBudgetInput): MemoryBudgetVerdict {
  if (input.policy.skip_memory_guard) return { ok: true };
  const dim = resolveEmbeddingDim(input.policy, input.hasEmbeddingsFile);
  const estimate = estimateClusterFootprintBytes(input.itemCount, dim);
  const heapLimit = input.heapLimitBytes ?? resolveHeapLimitBytes();
  const budget = heapLimit * HEAP_SAFETY_FRACTION;
  if (estimate <= budget) return { ok: true };

  const embeddingsBytes = input.itemCount * dim * BYTES_PER_EMBEDDING_COMPONENT;
  // Recommend a heap large enough that the same estimate fits under the safety
  // fraction: estimate <= HEAP_SAFETY_FRACTION × recommended.
  const recommendedHeapMb = Math.ceil(estimate / HEAP_SAFETY_FRACTION / (1024 * 1024));
  const lines: (string | null)[] = [
    `cluster_synonyms: estimated in-memory footprint ~${mb(estimate)} MB for ${input.itemCount} items` +
      (dim > 0
        ? ` (embeddings dim ${dim} ≈ ${mb(embeddingsBytes)} MB + ~${BASE_BYTES_PER_ITEM} B/item structures)`
        : ` (no embeddings; in-memory structures only)`) +
      ` exceeds the safe budget ~${mb(budget)} MB ` +
      `(${Math.round(HEAP_SAFETY_FRACTION * 100)}% of this process's ${mb(heapLimit)} MB V8 heap limit).`,
    `The run would OOM mid-flight AFTER spending LLM budget. To proceed, pick one:`,
    `  • raise the heap: run Node with --max-old-space-size=${recommendedHeapMb} (MB) or higher;`,
    dim > 0
      ? `  • set policy.compute_embeddings=false (drops ~${mb(embeddingsBytes)} MB; uses random batching instead of embedding-clustered batching);`
      : null,
    `  • reduce or pre-split the input corpus;`,
    `  • set policy.skip_memory_guard=true to override (you accept the OOM risk).`,
  ];
  return { ok: false, reason: lines.filter((l): l is string => l !== null).join("\n") };
}
