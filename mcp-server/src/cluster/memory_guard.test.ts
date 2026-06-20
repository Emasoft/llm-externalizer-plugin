// Unit tests for memory_guard.ts (TRDD-828238b5 B3). Pure arithmetic +
// verdict logic — no I/O, no LLM, no network. The live V8 heap limit is
// never read: every check injects heapLimitBytes.

import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY } from "./policy.js";
import type { ClusterPolicy } from "./types.js";
import {
  BASE_BYTES_PER_ITEM,
  BYTES_PER_EMBEDDING_COMPONENT,
  HEAP_SAFETY_FRACTION,
  DEFAULT_EMBEDDING_DIM,
  knownEmbeddingDim,
  resolveEmbeddingDim,
  estimateClusterFootprintBytes,
  checkClusterMemoryBudget,
} from "./memory_guard.js";

function policy(overrides: Partial<ClusterPolicy> = {}): ClusterPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe("knownEmbeddingDim", () => {
  it("knows the default all-MiniLM-L6-v2 dim (384)", () => {
    expect(knownEmbeddingDim("sentence-transformers/all-MiniLM-L6-v2")).toBe(384);
  });

  it("is case-insensitive and trims", () => {
    expect(knownEmbeddingDim("  SENTENCE-TRANSFORMERS/ALL-MPNET-BASE-V2 ")).toBe(768);
  });

  it("returns undefined for an unknown model", () => {
    expect(knownEmbeddingDim("acme/mystery-embedder-v9")).toBeUndefined();
  });
});

describe("resolveEmbeddingDim", () => {
  it("is 0 when no embeddings are computed and no file is supplied", () => {
    expect(resolveEmbeddingDim(policy({ compute_embeddings: false }), false)).toBe(0);
  });

  it("uses the known model dim when computing embeddings", () => {
    expect(
      resolveEmbeddingDim(
        policy({ compute_embeddings: true, embedding_model: "sentence-transformers/all-MiniLM-L6-v2" }),
        false,
      ),
    ).toBe(384);
  });

  it("falls back to the conservative default for an unknown model", () => {
    expect(
      resolveEmbeddingDim(policy({ compute_embeddings: true, embedding_model: "acme/unknown" }), false),
    ).toBe(DEFAULT_EMBEDDING_DIM);
  });

  it("treats a supplied embeddings_file as embeddings-present even when compute is off", () => {
    expect(resolveEmbeddingDim(policy({ compute_embeddings: false }), true)).toBe(384);
  });
});

describe("estimateClusterFootprintBytes", () => {
  it("counts only base structures when there are no embeddings (dim 0)", () => {
    expect(estimateClusterFootprintBytes(1000, 0)).toBe(1000 * BASE_BYTES_PER_ITEM);
  });

  it("adds the N×dim×4 embeddings bundle on top of the base", () => {
    const n = 10_000;
    const dim = 384;
    const expected = n * BASE_BYTES_PER_ITEM + n * dim * BYTES_PER_EMBEDDING_COMPONENT;
    expect(estimateClusterFootprintBytes(n, dim)).toBe(expected);
  });

  it("matches the TRDD's ~2 GB-at-1M default-path arithmetic (1M × 384-dim)", () => {
    // 1M × 384 × 4 ≈ 1.5 GB embeddings + 1M × 512 ≈ 0.5 GB base ≈ ~2 GB.
    const bytes = estimateClusterFootprintBytes(1_000_000, 384);
    expect(bytes / GB).toBeGreaterThan(1.9);
    expect(bytes / GB).toBeLessThan(2.1);
  });

  it("is monotonic in item count and dimension", () => {
    expect(estimateClusterFootprintBytes(2000, 384)).toBeGreaterThan(estimateClusterFootprintBytes(1000, 384));
    expect(estimateClusterFootprintBytes(1000, 768)).toBeGreaterThan(estimateClusterFootprintBytes(1000, 384));
  });

  it("treats negative inputs as zero (no negative footprint)", () => {
    expect(estimateClusterFootprintBytes(-5, 384)).toBe(0);
    expect(estimateClusterFootprintBytes(1000, -1)).toBe(1000 * BASE_BYTES_PER_ITEM);
  });
});

describe("checkClusterMemoryBudget", () => {
  it("passes a small corpus that fits well under the heap budget", () => {
    const v = checkClusterMemoryBudget({
      itemCount: 5_000,
      policy: policy(),
      hasEmbeddingsFile: false,
      heapLimitBytes: 4 * GB,
    });
    expect(v.ok).toBe(true);
  });

  it("fails a corpus whose estimate exceeds the safe fraction of the heap", () => {
    const v = checkClusterMemoryBudget({
      itemCount: 1_000_000,
      policy: policy(),
      hasEmbeddingsFile: false,
      heapLimitBytes: 2 * GB,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("cluster_synonyms");
      expect(v.reason).toContain("--max-old-space-size");
      expect(v.reason).toContain("compute_embeddings=false");
      expect(v.reason).toContain("skip_memory_guard=true");
      expect(v.reason).toContain("OOM");
    }
  });

  it("honors skip_memory_guard even for an impossible corpus", () => {
    const v = checkClusterMemoryBudget({
      itemCount: 100_000_000,
      policy: policy({ skip_memory_guard: true }),
      hasEmbeddingsFile: false,
      heapLimitBytes: 512 * MB,
    });
    expect(v.ok).toBe(true);
  });

  it("passes exactly at the budget boundary (estimate == budget)", () => {
    // Choose a heap limit so that budget == estimate for a no-embeddings corpus.
    const itemCount = 100_000;
    const estimate = estimateClusterFootprintBytes(itemCount, 0); // dim 0 → base only
    const heapLimitBytes = estimate / HEAP_SAFETY_FRACTION; // budget := frac × heap == estimate
    const v = checkClusterMemoryBudget({
      itemCount,
      policy: policy({ compute_embeddings: false }),
      hasEmbeddingsFile: false,
      heapLimitBytes,
    });
    expect(v.ok).toBe(true);
  });

  it("recommends a heap large enough that the same estimate would fit", () => {
    const itemCount = 500_000;
    const v = checkClusterMemoryBudget({
      itemCount,
      policy: policy(),
      hasEmbeddingsFile: false,
      heapLimitBytes: 1 * GB,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const m = v.reason.match(/--max-old-space-size=(\d+)/);
      expect(m).not.toBeNull();
      const recommendedMb = Number(m![1]);
      const estimate = estimateClusterFootprintBytes(itemCount, 384);
      // estimate must fit under the safety fraction of the recommended heap.
      expect(estimate).toBeLessThanOrEqual(HEAP_SAFETY_FRACTION * recommendedMb * MB);
    }
  });

  it("omits the disable-embeddings suggestion when the run already has no embeddings", () => {
    const v = checkClusterMemoryBudget({
      itemCount: 50_000_000,
      policy: policy({ compute_embeddings: false }),
      hasEmbeddingsFile: false,
      heapLimitBytes: 1 * GB,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain("no embeddings");
      expect(v.reason).not.toContain("compute_embeddings=false");
    }
  });
});
