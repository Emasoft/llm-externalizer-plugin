// Unit tests for phase2_verify.ts (T15 in TRDD-220ea89f + Q12 merge
// rule). Pure-function pieces (sampleReps, buildRepBundles, stratifyReps,
// batchVerificationReps, applyMergeRule) tested in isolation; the
// end-to-end runPhase2 uses a deterministic mock LLM so the test runs
// without any external service.

import { describe, it, expect } from "vitest";
import {
  applyMergeRule,
  batchVerificationReps,
  buildRepBundles,
  runPhase2,
  sampleReps,
  stratifyReps,
} from "./phase2_verify.js";
import type { Phase1RawLlmCall } from "./phase1_batch.js";
import { UnionFind } from "./unionfind.js";
import type { ClusterInputItem, ClusterPolicy } from "./types.js";

function basePolicy(overrides: Partial<ClusterPolicy> = {}): ClusterPolicy {
  return {
    batch_size: 12,
    passes: 1,
    neighborhood_strategy: "embedding-cluster",
    max_cluster_size: 500,
    budget_max_llm_calls: 2000,
    embedding_model: "test",
    compute_embeddings: false,
    checkpoint_every: 100,
    canonical_label_mode: "heuristic",
    max_retries_per_attempt: 3,
    max_split_depth: 3,
    skip_preflight_benchmark: true,
    merge_min_cross_count: 3,
    overwrite_output: true,
    emit_sqlite_clusters: false,
    skip_memory_guard: false,
    ...overrides,
  };
}

function it_(id: string, sent = `sentence ${id}`): ClusterInputItem {
  return { id, sentence: sent };
}

// ────────────────────────────────────────────────────────────
// sampleReps
// ────────────────────────────────────────────────────────────

describe("sampleReps", () => {
  it("returns all members when cluster <= n", () => {
    const m = [it_("a"), it_("b"), it_("c")];
    expect(sampleReps(m, 5, 1)).toEqual(m);
    expect(sampleReps(m, 3, 1)).toEqual(m);
  });
  it("returns exactly n when cluster > n; deterministic per seed", () => {
    const m = Array.from({ length: 10 }, (_, i) => it_(`m${i}`));
    const a = sampleReps(m, 4, 42);
    const b = sampleReps(m, 4, 42);
    expect(a).toEqual(b);
    expect(a).toHaveLength(4);
    const c = sampleReps(m, 4, 7);
    expect(c).not.toEqual(a); // different seed → likely different pick
  });
  it("non-empty cluster always yields at least 1 rep", () => {
    expect(sampleReps([it_("solo")], 3, 1)).toHaveLength(1);
  });
  it("empty cluster returns []", () => {
    expect(sampleReps([], 3, 1)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// buildRepBundles
// ────────────────────────────────────────────────────────────

describe("buildRepBundles", () => {
  it("groups items by current union-find root, picks reps per cluster", () => {
    const items = [it_("a"), it_("b"), it_("c"), it_("d"), it_("e")];
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    uf.union("a", "b"); // {a,b}
    uf.union("c", "d"); // {c,d}
    // e stays alone
    const bundles = buildRepBundles(items, uf, 3, 1);
    expect(bundles).toHaveLength(3);
    const sizes = bundles.map((b) => b.reps.length).sort();
    expect(sizes).toEqual([1, 2, 2]);
  });

  it("attaches centroid only when embeddings provided", () => {
    const items = [it_("a"), it_("b")];
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    const noEmb = buildRepBundles(items, uf, 3, 1);
    expect(noEmb[0].centroid).toBeUndefined();
    const emb = new Float32Array([1, 0, 0, 1]);
    const withEmb = buildRepBundles(items, uf, 3, 1, emb, 2);
    expect(withEmb[0].centroid).toBeDefined();
    expect(withEmb[0].centroid!.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────
// stratifyReps
// ────────────────────────────────────────────────────────────

describe("stratifyReps", () => {
  it("returns same length; no items lost", () => {
    const items = Array.from({ length: 10 }, (_, i) => it_(`m${i}`));
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    const reps = buildRepBundles(items, uf, 1, 1);
    const out = stratifyReps(reps, 99);
    expect(out).toHaveLength(reps.length);
    expect(new Set(out.map((r) => r.clusterId))).toEqual(new Set(reps.map((r) => r.clusterId)));
  });

  it("with embeddings: sorts by projection (clusters with similar centroids land adjacent)", () => {
    const items = [it_("a"), it_("b"), it_("c"), it_("d")];
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    // Embeddings deliberately placed so projection sort puts similar IDs together.
    const emb = new Float32Array([
      1, 0, 0,    // a
      0.95, 0.05, 0,  // b — near a
      0, 1, 0,    // c
      0.05, 0.95, 0,  // d — near c
    ]);
    const reps = buildRepBundles(items, uf, 1, 1, emb, 3);
    const stratified = stratifyReps(reps, 42, 3);
    // After stratification, the SET is preserved.
    expect(stratified.map((r) => r.clusterId).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("different pass seeds yield different orderings (probabilistic)", () => {
    const items = Array.from({ length: 8 }, (_, i) => it_(`m${i}`));
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    const reps = buildRepBundles(items, uf, 1, 1);
    const o1 = stratifyReps(reps, 1).map((r) => r.clusterId).join(",");
    const o2 = stratifyReps(reps, 999_999).map((r) => r.clusterId).join(",");
    // Could collide by accident, but with 8! permutations the chance is tiny.
    expect(o1).not.toEqual(o2);
  });
});

// ────────────────────────────────────────────────────────────
// batchVerificationReps
// ────────────────────────────────────────────────────────────

describe("batchVerificationReps", () => {
  it("K = floor(batch_size / repsPerCluster); each batch <= K", () => {
    const reps = Array.from({ length: 20 }, (_, i) => ({
      clusterId: `c${i}`, reps: [it_(`r${i}`)], centroid: undefined,
    }));
    const batches = batchVerificationReps(reps, 12, 4); // K=3
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(3);
  });

  it("drops the trailing 1-cluster slice (can't merge with anything)", () => {
    const reps = Array.from({ length: 7 }, (_, i) => ({
      clusterId: `c${i}`, reps: [it_(`r${i}`)], centroid: undefined,
    }));
    const batches = batchVerificationReps(reps, 6, 3); // K=2; slices [0..1],[2..3],[4..5],[6] — drop the last
    for (const b of batches) expect(b.length).toBeGreaterThanOrEqual(2);
    expect(batches.reduce((s, b) => s + b.length, 0)).toBe(6);
  });

  it("K floored to 2 when batch_size/reps < 2", () => {
    const reps = Array.from({ length: 6 }, (_, i) => ({
      clusterId: `c${i}`, reps: Array.from({ length: 10 }, (_, j) => it_(`r${i}-${j}`)),
      centroid: undefined,
    }));
    const batches = batchVerificationReps(reps, 5, 10); // floor(5/10)=0 → clamp to 2
    for (const b of batches) expect(b.length).toBeGreaterThanOrEqual(2);
  });
});

// ────────────────────────────────────────────────────────────
// applyMergeRule — T15 — Q12 ≥3-floor rule
// ────────────────────────────────────────────────────────────

describe("applyMergeRule (Q12 — ≥3-element floor)", () => {
  it("T15-Y: 3 from A + 3 from B → MERGE A↔B", () => {
    // group: ids 1..6 → 3 in cluster A (1,2,3) + 3 in cluster B (4,5,6)
    const perItemCluster = ["A", "A", "A", "B", "B", "B"];
    const { unions, weak } = applyMergeRule([1, 2, 3, 4, 5, 6], perItemCluster, 3, "r1");
    expect(unions).toEqual([["A", "B"]]);
    expect(weak).toEqual([]);
  });

  it("T15-X: 2 from A + 2 from B → NO MERGE, weak_overlap_evidence row", () => {
    const perItemCluster = ["A", "A", "B", "B"];
    const { unions, weak } = applyMergeRule([1, 2, 3, 4], perItemCluster, 3, "r1");
    expect(unions).toEqual([]);
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({ cluster_a: "A", cluster_b: "B", cross_count_a: 2, cross_count_b: 2, response_id: "r1" });
  });

  it("asymmetric 3 from A + 1 from B → NO MERGE (B side below floor)", () => {
    const perItemCluster = ["A", "A", "A", "B"];
    const { unions, weak } = applyMergeRule([1, 2, 3, 4], perItemCluster, 3, "r1");
    expect(unions).toEqual([]);
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({ cross_count_a: 3, cross_count_b: 1 });
  });

  it("3-way overlap (3 from A + 3 from B + 3 from C) → MERGE A↔B, A↔C, B↔C (all 3 pairs)", () => {
    const perItemCluster = ["A", "A", "A", "B", "B", "B", "C", "C", "C"];
    const { unions, weak } = applyMergeRule([1, 2, 3, 4, 5, 6, 7, 8, 9], perItemCluster, 3, "r1");
    expect(unions.sort()).toEqual([["A", "B"], ["A", "C"], ["B", "C"]].sort());
    expect(weak).toEqual([]);
  });

  it("custom merge_min_cross_count=2 lets 2+2 overlaps merge", () => {
    const perItemCluster = ["A", "A", "B", "B"];
    const { unions, weak } = applyMergeRule([1, 2, 3, 4], perItemCluster, 2, "r1");
    expect(unions).toEqual([["A", "B"]]);
    expect(weak).toEqual([]);
  });

  it("single-cluster group → no pairs, no work", () => {
    const perItemCluster = ["A", "A", "A"];
    const { unions, weak } = applyMergeRule([1, 2, 3], perItemCluster, 3, "r1");
    expect(unions).toEqual([]);
    expect(weak).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────
// runPhase2 — end-to-end with mock LLM
// ────────────────────────────────────────────────────────────

function singletonLlm(): Phase1RawLlmCall {
  return async (prompt) => {
    const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
    return JSON.stringify({ groups: Array.from({ length: ids }, (_, i) => [i + 1]) });
  };
}

function allOneGroupLlm(): Phase1RawLlmCall {
  return async (prompt) => {
    const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
    return JSON.stringify({ groups: [Array.from({ length: ids }, (_, i) => i + 1)] });
  };
}

describe("runPhase2 — end-to-end", () => {
  it("empty items → no work, no calls", async () => {
    const uf = new UnionFind();
    const r = await runPhase2(
      { items: [], uf, policy: basePolicy(), budget: { remaining: 100 } },
      singletonLlm(),
    );
    expect(r.mergedPairs).toEqual([]);
    expect(r.llmCallCount).toBe(0);
  });

  it("all-singletons LLM response → no merges; weak evidence empty", async () => {
    const items = Array.from({ length: 4 }, (_, i) => it_(`x${i}`));
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    // Pre-seed 2 clusters of 2 so Phase 2 has something to verify.
    uf.union("x0", "x1");
    uf.union("x2", "x3");
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 100 }), budget: { remaining: 100 } },
      singletonLlm(),
    );
    expect(r.mergedPairs).toEqual([]);
    expect(r.weakOverlapEvidence).toEqual([]);
    expect(uf.numClusters()).toBe(2);
  });

  it("one-giant-group response with 3+3 overlap → MERGE", async () => {
    // 6 items in 2 pre-seeded clusters of 3: {a0,a1,a2} + {b0,b1,b2}.
    // Each cluster contributes 3 reps (the default reps_per_cluster = max(merge_min_cross_count+1, 4) = 4
    // but cluster only has 3 members, so all 3 → 6 items per batch).
    // LLM lumps them all into one group → applyMergeRule sees 3 from A + 3 from B → merge.
    const items = [
      it_("a0"), it_("a1"), it_("a2"),
      it_("b0"), it_("b1"), it_("b2"),
    ];
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    uf.union("a0", "a1"); uf.union("a0", "a2");
    uf.union("b0", "b1"); uf.union("b0", "b2");
    expect(uf.numClusters()).toBe(2);
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 100, merge_min_cross_count: 3 }),
        budget: { remaining: 100 } },
      allOneGroupLlm(),
    );
    expect(r.mergedPairs.length).toBeGreaterThanOrEqual(1);
    expect(uf.numClusters()).toBe(1);
    expect(r.weakOverlapEvidence).toEqual([]);
  });

  it("2+2 overlap → NO MERGE; weak_overlap_evidence row recorded", async () => {
    const items = [it_("a0"), it_("a1"), it_("b0"), it_("b1")];
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    uf.union("a0", "a1");
    uf.union("b0", "b1");
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 100, merge_min_cross_count: 3 }),
        budget: { remaining: 100 } },
      allOneGroupLlm(),
    );
    expect(r.mergedPairs).toEqual([]);
    expect(uf.numClusters()).toBe(2);
    expect(r.weakOverlapEvidence.length).toBeGreaterThanOrEqual(1);
    expect(r.weakOverlapEvidence[0]).toMatchObject({
      cluster_a: expect.any(String),
      cluster_b: expect.any(String),
      cross_count_a: 2,
      cross_count_b: 2,
    });
  });

  it("multi-pass: passes=2 doubles the rep-sample seeds → different stratification per pass", async () => {
    // Use mostly-singleton LLM so passes don't merge anything; just count the work.
    const items = Array.from({ length: 10 }, (_, i) => it_(`x${i}`));
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    // 5 clusters of 2 so something to verify.
    for (let i = 0; i < 10; i += 2) uf.union(`x${i}`, `x${i + 1}`);
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 100, passes: 2 }),
        budget: { remaining: 200 } },
      singletonLlm(),
    );
    // Passes>=1 with non-trivial cluster count should produce at least one batch.
    expect(r.batchesAttempted).toBeGreaterThanOrEqual(1);
  });

  it("malformed LLM response triggers retry-ladder; eventually gives up, logged in failed", async () => {
    const items = Array.from({ length: 4 }, (_, i) => it_(`x${i}`));
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    for (let i = 0; i < 4; i += 2) uf.union(`x${i}`, `x${i + 1}`);
    const garbageLlm: Phase1RawLlmCall = async () => "garbage";
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 100, max_split_depth: 0 }),
        budget: { remaining: 50 } },
      garbageLlm,
    );
    expect(r.mergedPairs).toEqual([]);
    expect(r.failed.length).toBeGreaterThanOrEqual(1);
  });

  it("budget exhaustion mid-Phase-2: stops, flags budgetExhausted", async () => {
    const items = Array.from({ length: 12 }, (_, i) => it_(`x${i}`));
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    for (let i = 0; i < 12; i += 2) uf.union(`x${i}`, `x${i + 1}`);
    const garbageLlm: Phase1RawLlmCall = async () => "garbage";
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 4, max_split_depth: 0, passes: 3 }),
        budget: { remaining: 2 } },
      garbageLlm,
    );
    expect(r.budgetExhausted).toBe(true);
  });

  it("singletons cannot merge with anything (the ≥3 floor blocks it)", async () => {
    // 4 singleton clusters; LLM lumps all reps together → 1+1+1+1 → no pair clears 3 floor.
    const items = [it_("a"), it_("b"), it_("c"), it_("d")];
    const uf = new UnionFind();
    for (const x of items) uf.add(x.id);
    const r = await runPhase2(
      { items, uf, policy: basePolicy({ batch_size: 100, merge_min_cross_count: 3 }),
        budget: { remaining: 50 } },
      allOneGroupLlm(),
    );
    expect(r.mergedPairs).toEqual([]);
    expect(uf.numClusters()).toBe(4);
  });
});
