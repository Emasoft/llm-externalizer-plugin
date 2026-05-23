// Phase 2 of cluster_synonyms (TRDD-220ea89f §7 Phase 2 + Q12).
// After Phase 1, we have a union-find partition where each cluster is a
// group of items the LLM said share a meaning *within a single batch*.
// Phase 2 checks whether items that landed in DIFFERENT batches but
// belong to the same concept can be merged across cluster boundaries.
//
// The algorithm:
//   1. Take the current partition.
//   2. For each cluster, pick `reps_per_cluster` representatives (default
//      max(merge_min_cross_count + 1, 4)). Singletons contribute their
//      one item — they can't trigger a merge alone (the ≥3 floor blocks
//      it) but their inclusion still surfaces evidence in the report.
//   3. Stratify: cluster reps so semantically-near clusters land in the
//      same verification batch (so the LLM has a chance to spot a real
//      merge). When embeddings are available we project centroids onto
//      a per-pass-varying random direction and sort. Without embeddings
//      we shuffle deterministically with the pass index as seed.
//   4. Dispatch each batch through retry_ladder, validating the same
//      Phase1Response shape ({"groups": [[id, …], …]}).
//   5. For each response-group, apply the **Q12 transitive-closure merge
//      rule with ≥3-element floor**: count co-occurrences per
//      (cluster_a, cluster_b) pair; if BOTH counts are ≥
//      merge_min_cross_count, union A↔B; else log to
//      weak_overlap_evidence (1- and 2-overlap stays in the report but
//      does NOT merge).
//   6. Repeat for `policy.passes` total iterations — different passes
//      use different stratification directions so concept neighborhoods
//      missed by pass 1 get a second look.

import {
  processBatchWithRetry,
  type LlmCallFn,
  type RetryBudget,
  type ValidateFn,
} from "./retry_ladder.js";
import {
  Phase1ResponseSchema,
  buildPhase1Prompt,
  validatePhase1Response,
  type Phase1Response,
  type Phase1RawLlmCall,
} from "./phase1_batch.js";
import { UnionFind } from "./unionfind.js";
import type {
  ClusterInputItem,
  ClusterPolicy,
  FailedGroup,
  WeakOverlapEvidence,
} from "./types.js";

// Re-export the schema so callers don't have to bridge two modules.
export { Phase1ResponseSchema };

export interface Phase2Inputs {
  items: ClusterInputItem[];
  /** Optional flat row-major float32 buffer of length items.length × dim. */
  embeddings?: Float32Array;
  dim?: number;
  /** Current union-find — Phase 2 mutates it as merges happen. */
  uf: UnionFind;
  policy: ClusterPolicy;
  budget: RetryBudget;
  /** Override the rep sampler's count; defaults to
   *  `max(policy.merge_min_cross_count + 1, 4)`. */
  repsPerCluster?: number;
  /** Deterministic seed base — pass index XOR'd in so the stratifier
   *  varies per pass. */
  seed?: number;
}

export interface Phase2Result {
  /** Cluster-id pairs that Phase 2 merged. Each pair represents one
   *  union operation already applied to `uf`. */
  mergedPairs: Array<[string, string]>;
  /** Co-occurrences below the merge floor — logged in stats.json for
   *  operator review, NOT applied to the union-find. */
  weakOverlapEvidence: WeakOverlapEvidence[];
  /** Verification batches that gave up at the leaf — items NOT merged. */
  failed: FailedGroup[];
  llmCallCount: number;
  batchesAttempted: number;
  batchesSucceeded: number;
  budgetExhausted: boolean;
  warnings: string[];
}

/** A representative bundle: one cluster, the items chosen as its reps,
 *  and the cluster's centroid (when embeddings are available). */
interface ClusterRep {
  clusterId: string;          // = uf.find(...) for every member
  reps: ClusterInputItem[];   // chosen members
  centroid: Float32Array | undefined; // present iff embeddings provided
}

// Mulberry32 — same PRNG used by kmeans / phase1.
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

/** Pick up to `n` items from a cluster, deterministically (Fisher-Yates
 *  on a per-cluster RNG so the same pass+cluster always picks the same
 *  reps). Always returns at least 1 item when the cluster is non-empty. */
export function sampleReps(members: ClusterInputItem[], n: number, seed: number): ClusterInputItem[] {
  if (members.length <= n) return members.slice();
  const rng = makeRng(seed);
  const idx = members.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx.slice(0, n).map((i) => members[i]);
}

/** Compute the mean of N vectors of dimension `dim`. */
function meanOf(vectors: Float32Array[], dim: number): Float32Array {
  if (vectors.length === 0) return new Float32Array(dim);
  const out = new Float32Array(dim);
  for (const v of vectors) {
    for (let d = 0; d < dim; d++) out[d] += v[d];
  }
  for (let d = 0; d < dim; d++) out[d] /= vectors.length;
  return out;
}

/** Build the per-cluster rep bundle. */
export function buildRepBundles(
  items: ClusterInputItem[],
  uf: UnionFind,
  repsPerCluster: number,
  passSeed: number,
  embeddings?: Float32Array,
  dim?: number,
): ClusterRep[] {
  // Group items by current cluster root.
  const byRoot = new Map<string, { members: ClusterInputItem[]; vectors: Float32Array[] }>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!uf.has(it.id)) uf.add(it.id);
    const root = uf.find(it.id);
    let bucket = byRoot.get(root);
    if (!bucket) {
      bucket = { members: [], vectors: [] };
      byRoot.set(root, bucket);
    }
    bucket.members.push(it);
    if (embeddings && dim) bucket.vectors.push(embeddings.subarray(i * dim, (i + 1) * dim));
  }

  const out: ClusterRep[] = [];
  // Iterate in deterministic root order so the per-cluster seed is
  // reproducible across re-runs.
  const sortedRoots = Array.from(byRoot.keys()).sort();
  for (const root of sortedRoots) {
    const bucket = byRoot.get(root)!;
    const clusterSeed = (hashString(root) ^ passSeed) >>> 0;
    const reps = sampleReps(bucket.members, repsPerCluster, clusterSeed);
    const centroid = embeddings && dim ? meanOf(bucket.vectors, dim) : undefined;
    out.push({ clusterId: root, reps, centroid });
  }
  return out;
}

// Tiny deterministic string hash (FNV-1a 32-bit) for per-cluster seeds.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Stratify the cluster reps so semantically-near clusters end up in
 *  consecutive positions (so consecutive batches contain related
 *  concepts). The projection direction is per-pass so different passes
 *  see different neighborhoods. */
export function stratifyReps(reps: ClusterRep[], passSeed: number, dim?: number): ClusterRep[] {
  if (reps.length <= 1) return reps;
  if (!dim || reps.some((r) => r.centroid === undefined)) {
    // No embeddings — deterministic shuffle, different per pass.
    const rng = makeRng(passSeed ^ 0xDEADBEEF);
    const idx = reps.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    return idx.map((i) => reps[i]);
  }
  // Random unit vector for projection.
  const rng = makeRng(passSeed ^ 0x9E3779B1);
  const proj = new Float32Array(dim);
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    // Box-Muller approximation via two uniforms; cheap, good enough.
    const u = rng() || 1e-12;
    const v = rng();
    proj[d] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    norm += proj[d] * proj[d];
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) proj[d] /= norm;

  // Score each cluster by dot product against the projection direction.
  const scored = reps.map((r) => {
    let s = 0;
    if (r.centroid) {
      for (let d = 0; d < dim; d++) s += r.centroid[d] * proj[d];
    }
    return { rep: r, score: s };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.rep);
}

/** Pack stratified reps into verification batches. Each batch contains
 *  reps from `K = floor(batch_size / repsPerCluster)` adjacent clusters.
 *  When K < 2 we fall back to K = 2 (need at least 2 clusters per batch
 *  for any cross-cluster merge to be possible). */
export function batchVerificationReps(
  stratified: ClusterRep[],
  batchSize: number,
  repsPerCluster: number,
): ClusterRep[][] {
  const K = Math.max(2, Math.floor(batchSize / Math.max(1, repsPerCluster)));
  const out: ClusterRep[][] = [];
  for (let off = 0; off < stratified.length; off += K) {
    const slice = stratified.slice(off, off + K);
    if (slice.length >= 2) out.push(slice);
    // Trailing 1-cluster slice can't merge with anything — drop it.
  }
  return out;
}

/** Apply the Q12 merge rule to one response group. Returns the unions
 *  to perform AND the weak-overlap rows. Pure function — does NOT
 *  mutate the union-find. */
export function applyMergeRule(
  group: number[],
  perItemCluster: string[],
  minCrossCount: number,
  responseId: string,
): { unions: Array<[string, string]>; weak: WeakOverlapEvidence[] } {
  // Count items per cluster within this group.
  const byCluster = new Map<string, number>();
  for (const numId of group) {
    const cluster = perItemCluster[numId - 1];
    if (!cluster) continue;
    byCluster.set(cluster, (byCluster.get(cluster) ?? 0) + 1);
  }
  const clusterIds = Array.from(byCluster.keys()).sort();
  const unions: Array<[string, string]> = [];
  const weak: WeakOverlapEvidence[] = [];
  for (let i = 0; i < clusterIds.length; i++) {
    const A = clusterIds[i];
    const countA = byCluster.get(A)!;
    for (let j = i + 1; j < clusterIds.length; j++) {
      const B = clusterIds[j];
      const countB = byCluster.get(B)!;
      if (countA >= minCrossCount && countB >= minCrossCount) {
        unions.push([A, B]);
      } else {
        weak.push({
          response_id: responseId,
          cluster_a: A,
          cluster_b: B,
          cross_count_a: countA,
          cross_count_b: countB,
        });
      }
    }
  }
  return { unions, weak };
}

export async function runPhase2(
  inputs: Phase2Inputs,
  rawLlmCall: Phase1RawLlmCall,
): Promise<Phase2Result> {
  const { items, embeddings, dim, uf, policy, budget } = inputs;
  const repsPerCluster = inputs.repsPerCluster ?? Math.max(policy.merge_min_cross_count + 1, 4);
  const baseSeed = inputs.seed ?? 0x1234567;
  const mergedPairs: Array<[string, string]> = [];
  const weakEvidence: WeakOverlapEvidence[] = [];
  const failed: FailedGroup[] = [];
  const warnings: string[] = [];
  let llmCallCount = 0;
  let batchesAttempted = 0;
  let batchesSucceeded = 0;
  let budgetExhausted = false;

  if (items.length === 0) {
    return {
      mergedPairs, weakOverlapEvidence: weakEvidence, failed,
      llmCallCount, batchesAttempted, batchesSucceeded, budgetExhausted, warnings,
    };
  }

  for (let pass = 0; pass < policy.passes; pass++) {
    if (budgetExhausted) break;
    const passSeed = (baseSeed ^ ((pass + 1) * 0xA5A5A5A5)) >>> 0;
    const repBundles = buildRepBundles(items, uf, repsPerCluster, passSeed, embeddings, dim);
    if (repBundles.length < 2) {
      warnings.push(`phase2 pass ${pass + 1}: fewer than 2 clusters — nothing to verify`);
      continue;
    }
    const stratified = stratifyReps(repBundles, passSeed, dim);
    const batches = batchVerificationReps(stratified, policy.batch_size, repsPerCluster);
    if (batches.length === 0) {
      warnings.push(`phase2 pass ${pass + 1}: no batches formed`);
      continue;
    }

    for (let bi = 0; bi < batches.length; bi++) {
      if (budgetExhausted) break;
      const batch = batches[bi];
      // Flatten reps for the LLM, preserving the per-item cluster mapping
      // for post-response analysis.
      const slice: ClusterInputItem[] = [];
      const perItemCluster: string[] = [];
      for (const cr of batch) {
        for (const r of cr.reps) {
          slice.push(r);
          perItemCluster.push(cr.clusterId);
        }
      }
      batchesAttempted += 1;

      const llmCall: LlmCallFn<ClusterInputItem, Phase1Response> = async (innerSlice) => {
        const prompt = buildPhase1Prompt(innerSlice);
        const raw = await rawLlmCall(prompt);
        const parsed = JSON.parse(raw);
        return Phase1ResponseSchema.parse(parsed);
      };
      const validate: ValidateFn<ClusterInputItem, Phase1Response> = (response, innerSlice) =>
        validatePhase1Response(response, innerSlice.length);

      const result = await processBatchWithRetry(
        slice,
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
        // The leaf may be a sub-slice after a ladder split — recompute
        // perItemCluster for THIS leaf by mapping its items back to the
        // original slice index.
        const leafPerCluster: string[] = leaf.items.map((it) => {
          // Items in `slice` are unique per phase 2 batch since reps are
          // distinct ClusterInputItem objects across clusters. Find by id.
          const idx = slice.findIndex((s) => s.id === it.id);
          return idx >= 0 ? perItemCluster[idx] : "";
        });
        const responseIdPrefix = `pass${pass + 1}.b${bi + 1}.d${leaf.depth}`;
        for (let gi = 0; gi < leaf.response.groups.length; gi++) {
          const group = leaf.response.groups[gi];
          const responseId = `${responseIdPrefix}.g${gi + 1}`;
          const { unions, weak } = applyMergeRule(
            group,
            leafPerCluster,
            policy.merge_min_cross_count,
            responseId,
          );
          for (const [a, b] of unions) {
            const newRoot = uf.union(a, b);
            if (newRoot !== null) mergedPairs.push([a, b]);
          }
          weakEvidence.push(...weak);
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
    }
  }

  return {
    mergedPairs,
    weakOverlapEvidence: weakEvidence,
    failed,
    llmCallCount,
    batchesAttempted,
    batchesSucceeded,
    budgetExhausted,
    warnings,
  };
}
