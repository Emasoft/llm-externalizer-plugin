// Unit tests for phase1_batch.ts (T-phase1 in TRDD-220ea89f). The LLM
// call is a deterministic mock that interprets the prompt by parsing
// the items list back out — no external service. Verifies prompt
// construction, k-means batching, random-batching fallback (T6),
// response validation (missing/extra/duplicate ids), edge emission,
// failed-group recording, and budget propagation.

import { describe, it, expect } from "vitest";
import {
  buildPhase1Prompt,
  planPhase1Batches,
  validatePhase1Response,
  runPhase1,
  Phase1ResponseSchema,
  type Phase1RawLlmCall,
  type Phase1Inputs,
  type Phase1Response,
} from "./phase1_batch.js";
import type { ClusterInputItem, ClusterPolicy } from "./types.js";

function basePolicy(overrides: Partial<ClusterPolicy> = {}): ClusterPolicy {
  return {
    batch_size: 10,
    passes: 1,
    neighborhood_strategy: "embedding-cluster",
    max_cluster_size: 500,
    budget_max_llm_calls: 2000,
    embedding_model: "test",
    compute_embeddings: true,
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

function items(n: number, prefix = "item"): ClusterInputItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    sentence: `${prefix} number ${i}`,
  }));
}

/** Build a flat embeddings buffer where item i has a one-hot vector at
 *  position `i % dim`. Items that share `i % dim` cluster together. */
function oneHotEmbeddings(n: number, dim: number): Float32Array {
  const buf = new Float32Array(n * dim);
  for (let i = 0; i < n; i++) {
    buf[i * dim + (i % dim)] = 1;
  }
  return buf;
}

// ────────────────────────────────────────────────────────────
// buildPhase1Prompt
// ────────────────────────────────────────────────────────────

describe("buildPhase1Prompt", () => {
  it("emits numeric per-batch ids starting at 1, escapes quotes/backslashes, omits empty context", () => {
    const itms: ClusterInputItem[] = [
      { id: "x", sentence: 'has "quote"' },
      { id: "y", sentence: "has \\ backslash", context: 'ctx "with" quotes' },
      { id: "z", sentence: "plain" },
    ];
    const prompt = buildPhase1Prompt(itms);
    expect(prompt).toContain('1. id=1  sentence="has \\"quote\\""');
    expect(prompt).toContain('2. id=2  sentence="has \\\\ backslash"  ctx="ctx \\"with\\" quotes"');
    expect(prompt).toContain('3. id=3  sentence="plain"');
    expect(prompt).not.toContain('ctx=""');
    expect(prompt).toContain("Output:");
  });

  it("contains the SENTENCE-equivalence rules from the TRDD prompt template", () => {
    const prompt = buildPhase1Prompt([{ id: "a", sentence: "foo" }]);
    expect(prompt).toContain("Group sentences that have IDENTICAL or NEARLY-IDENTICAL");
    expect(prompt).toContain("NOT doing word-by-word synonym matching");
    expect(prompt).toContain("Every input id MUST appear exactly once");
  });
});

// ────────────────────────────────────────────────────────────
// Phase1ResponseSchema
// ────────────────────────────────────────────────────────────

describe("Phase1ResponseSchema", () => {
  it("accepts well-formed responses", () => {
    expect(Phase1ResponseSchema.parse({ groups: [[1, 2], [3]] })).toEqual({ groups: [[1, 2], [3]] });
    expect(Phase1ResponseSchema.parse({ groups: [] })).toEqual({ groups: [] });
  });
  it("rejects non-integer ids", () => {
    expect(() => Phase1ResponseSchema.parse({ groups: [[1.5]] })).toThrow();
  });
  it("rejects zero or negative ids (positive() guard)", () => {
    expect(() => Phase1ResponseSchema.parse({ groups: [[0]] })).toThrow();
    expect(() => Phase1ResponseSchema.parse({ groups: [[-1]] })).toThrow();
  });
  it("rejects string ids", () => {
    expect(() => Phase1ResponseSchema.parse({ groups: [["1"]] })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────
// validatePhase1Response
// ────────────────────────────────────────────────────────────

describe("validatePhase1Response", () => {
  it("ok when every id appears exactly once across all groups", () => {
    expect(validatePhase1Response({ groups: [[1, 2], [3]] }, 3)).toEqual({ ok: true });
  });
  it("ok with all singletons", () => {
    expect(validatePhase1Response({ groups: [[1], [2], [3]] }, 3)).toEqual({ ok: true });
  });
  it("ok with one giant group", () => {
    expect(validatePhase1Response({ groups: [[1, 2, 3, 4]] }, 4)).toEqual({ ok: true });
  });
  it("rejects out-of-range id", () => {
    const r = validatePhase1Response({ groups: [[1, 2, 99]] }, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/out of range/);
  });
  it("rejects duplicate id across groups", () => {
    const r = validatePhase1Response({ groups: [[1, 2], [2, 3]] }, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/multiple groups/);
  });
  it("rejects missing id", () => {
    const r = validatePhase1Response({ groups: [[1, 2]] }, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing/);
  });
  it("rejects empty group", () => {
    const r = validatePhase1Response({ groups: [[1, 2], []] }, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty group/);
  });
});

// ────────────────────────────────────────────────────────────
// planPhase1Batches
// ────────────────────────────────────────────────────────────

describe("planPhase1Batches", () => {
  it("returns no batches for empty input", () => {
    const r = planPhase1Batches({
      items: [],
      policy: basePolicy(),
      budget: { remaining: 100 },
    });
    expect(r.batches).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("random batching when compute_embeddings=false (T6)", () => {
    const r = planPhase1Batches({
      items: items(8),
      policy: basePolicy({ compute_embeddings: false, batch_size: 4 }),
      budget: { remaining: 100 },
    });
    expect(r.batches).toHaveLength(2);
    expect(r.batches[0]).toHaveLength(4);
    expect(r.batches[1]).toHaveLength(4);
    expect(r.warnings.some((w) => w.includes("compute_embeddings=false"))).toBe(true);
  });

  it("random batching with warning when compute_embeddings=true but no embeddings supplied (T6 fallback)", () => {
    const r = planPhase1Batches({
      items: items(6),
      policy: basePolicy({ compute_embeddings: true, batch_size: 3 }),
      budget: { remaining: 100 },
    });
    expect(r.batches).toHaveLength(2);
    expect(r.warnings.some((w) => w.includes("no usable embeddings"))).toBe(true);
  });

  it("k-means batching when embeddings supplied", () => {
    const itms = items(6);
    const embs = oneHotEmbeddings(6, 3); // i%3 → 3 clusters of 2 items
    const r = planPhase1Batches({
      items: itms,
      embeddings: embs,
      dim: 3,
      policy: basePolicy({ batch_size: 100 }), // K = ceil(6/100) = 1
      budget: { remaining: 100 },
    });
    // K=1 → one bucket with all 6 items
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0]).toHaveLength(6);
    expect(r.warnings).toEqual([]);
  });

  it("k-means K is ceil(N / batch_size) so batches are <= batch_size", () => {
    const itms = items(20);
    const embs = oneHotEmbeddings(20, 5);
    const r = planPhase1Batches({
      items: itms,
      embeddings: embs,
      dim: 5,
      policy: basePolicy({ batch_size: 7 }),
      budget: { remaining: 100 },
    });
    // K = ceil(20/7) = 3. Every produced batch must be <= 7.
    for (const b of r.batches) {
      expect(b.length).toBeLessThanOrEqual(7);
    }
    // Sum of batch sizes equals N (no item lost).
    expect(r.batches.reduce((s, b) => s + b.length, 0)).toBe(20);
  });

  it("partitions are a permutation of the input — no duplicates, no losses", () => {
    const itms = items(15);
    const embs = oneHotEmbeddings(15, 4);
    const r = planPhase1Batches({
      items: itms,
      embeddings: embs,
      dim: 4,
      policy: basePolicy({ batch_size: 5 }),
      budget: { remaining: 100 },
    });
    const ids = new Set(r.batches.flat().map((it) => it.id));
    expect(ids.size).toBe(15);
    expect(itms.every((it) => ids.has(it.id))).toBe(true);
  });

  it("dim mismatch falls back to random batching", () => {
    const itms = items(4);
    const embs = oneHotEmbeddings(4, 3);
    const r = planPhase1Batches({
      items: itms,
      embeddings: embs,
      dim: 99, // wrong dim — length mismatch
      policy: basePolicy({ batch_size: 4 }),
      budget: { remaining: 100 },
    });
    expect(r.batches).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("no usable embeddings"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// runPhase1 — happy paths
// ────────────────────────────────────────────────────────────

/** Make a mock LLM that, given the prompt, returns each item as a
 *  singleton — never groups. No edges expected. */
function singletonLlm(): Phase1RawLlmCall {
  return async (prompt: string) => {
    const idLines = prompt.match(/^\d+\. id=\d+/gm) ?? [];
    const groups = idLines.map((_, i) => [i + 1]);
    return JSON.stringify({ groups });
  };
}

/** Make a mock LLM that returns ALL items in one giant group. Edges:
 *  every item paired with item 1. */
function oneGroupLlm(): Phase1RawLlmCall {
  return async (prompt: string) => {
    const idLines = prompt.match(/^\d+\. id=\d+/gm) ?? [];
    const groups = [idLines.map((_, i) => i + 1)];
    return JSON.stringify({ groups });
  };
}

/** Make a mock LLM that groups pairs (1,2)(3,4)(5,6)... — for parity
 *  with the T2 (pure synonyms) scenario. */
function pairGroupsLlm(): Phase1RawLlmCall {
  return async (prompt: string) => {
    const idLines = prompt.match(/^\d+\. id=\d+/gm) ?? [];
    const n = idLines.length;
    const groups: number[][] = [];
    for (let i = 0; i < n; i += 2) {
      if (i + 1 < n) groups.push([i + 1, i + 2]);
      else groups.push([i + 1]);
    }
    return JSON.stringify({ groups });
  };
}

describe("runPhase1 — happy paths", () => {
  it("empty items → empty result, no LLM calls", async () => {
    const r = await runPhase1(
      { items: [], policy: basePolicy(), budget: { remaining: 100 } },
      singletonLlm(),
    );
    expect(r.edges).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.llmCallCount).toBe(0);
    expect(r.batchesAttempted).toBe(0);
    expect(r.budgetExhausted).toBe(false);
  });

  it("all-singleton response → zero edges, batches succeed", async () => {
    const itms = items(6);
    const r = await runPhase1(
      {
        items: itms,
        embeddings: oneHotEmbeddings(6, 3),
        dim: 3,
        policy: basePolicy({ batch_size: 10 }),
        budget: { remaining: 100 },
      },
      singletonLlm(),
    );
    expect(r.edges).toEqual([]);
    expect(r.batchesSucceeded).toBe(r.batchesAttempted);
    expect(r.llmCallCount).toBeGreaterThan(0);
    expect(r.budgetExhausted).toBe(false);
  });

  it("one-group response → emits N-1 edges anchored on item 1, all item ids preserved", async () => {
    const itms = items(5);
    const r = await runPhase1(
      {
        items: itms,
        embeddings: oneHotEmbeddings(5, 5),
        dim: 5,
        policy: basePolicy({ batch_size: 100 }), // 1 batch
        budget: { remaining: 100 },
      },
      oneGroupLlm(),
    );
    expect(r.batchesAttempted).toBe(1);
    expect(r.edges).toHaveLength(4);
    const allInvolved = new Set(r.edges.flatMap((e) => [e.a, e.b]));
    for (const it of itms) expect(allInvolved.has(it.id)).toBe(true);
  });

  it("pair-groups response → exactly N/2 edges", async () => {
    const itms = items(6);
    const r = await runPhase1(
      {
        items: itms,
        embeddings: oneHotEmbeddings(6, 6),
        dim: 6,
        policy: basePolicy({ batch_size: 100 }),
        budget: { remaining: 100 },
      },
      pairGroupsLlm(),
    );
    expect(r.edges).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────
// runPhase1 — failure modes
// ────────────────────────────────────────────────────────────

describe("runPhase1 — failure modes", () => {
  it("malformed JSON response: retries, splits, eventually gives up — items land in failed", async () => {
    const llm: Phase1RawLlmCall = async () => "not json";
    const r = await runPhase1(
      {
        items: items(4),
        policy: basePolicy({ batch_size: 100, compute_embeddings: false }),
        budget: { remaining: 200 },
      },
      llm,
    );
    expect(r.edges).toEqual([]);
    expect(r.failed.length).toBeGreaterThan(0);
    // Every failed leaf at max split depth (3) or one-item leaf.
    for (const f of r.failed) {
      expect(f.last_error.length).toBeGreaterThan(0);
    }
    // 4 items → depth-3 leaves: 4 items / 8 leaves = some empty; expect 4 leaves of 1 or fewer.
    const totalItems = r.failed.reduce((s, f) => s + f.item_ids.length, 0);
    expect(totalItems).toBe(4);
  });

  it("validation rejection (missing id) counts as a failed attempt — eventually gives up", async () => {
    // LLM always omits the last id.
    const llm: Phase1RawLlmCall = async (prompt) => {
      const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
      const groups: number[][] = [];
      for (let i = 1; i < ids; i++) groups.push([i]); // omit `ids`
      return JSON.stringify({ groups });
    };
    const r = await runPhase1(
      {
        items: items(2),
        policy: basePolicy({ batch_size: 100, compute_embeddings: false, max_split_depth: 0 }),
        budget: { remaining: 50 },
      },
      llm,
    );
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].item_ids).toEqual(["item-0", "item-1"]);
    expect(r.failed[0].last_error).toMatch(/missing/);
    expect(r.failed[0].attempt_count).toBe(3);
  });

  it("validation rejection (duplicate id) treated as failed attempt", async () => {
    const llm: Phase1RawLlmCall = async (prompt) => {
      const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
      // Put id 1 in two groups.
      const groups: number[][] = [[1, 2], [1]];
      for (let i = 3; i <= ids; i++) groups.push([i]);
      return JSON.stringify({ groups });
    };
    const r = await runPhase1(
      {
        items: items(3),
        policy: basePolicy({ batch_size: 100, compute_embeddings: false, max_split_depth: 0 }),
        budget: { remaining: 50 },
      },
      llm,
    );
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].last_error).toMatch(/multiple groups/);
  });

  it("transient failures (first attempt throws, retry succeeds) → batch ultimately succeeds", async () => {
    let attempt = 0;
    const llm: Phase1RawLlmCall = async (prompt) => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
      const groups = Array.from({ length: ids }, (_, i) => [i + 1]);
      return JSON.stringify({ groups });
    };
    const r = await runPhase1(
      {
        items: items(3),
        policy: basePolicy({ batch_size: 100, compute_embeddings: false }),
        budget: { remaining: 50 },
      },
      llm,
    );
    expect(r.failed).toEqual([]);
    expect(r.llmCallCount).toBe(2);
    expect(r.batchesSucceeded).toBe(1);
  });

  it("budget exhaustion mid-run flips budgetExhausted and stops dispatching more batches", async () => {
    // 12 items, batch_size 4 → 3 batches; budget 4 → after batch 1 (3 calls success
    // + nothing more) only ~1 more call possible. We force failures via JSON garbage
    // so each batch burns 3 calls.
    const llm: Phase1RawLlmCall = async () => "garbage";
    const r = await runPhase1(
      {
        items: items(12),
        policy: basePolicy({
          batch_size: 4,
          compute_embeddings: false,
          max_split_depth: 0,
        }),
        budget: { remaining: 4 },
      },
      llm,
    );
    expect(r.budgetExhausted).toBe(true);
    expect(r.llmCallCount).toBeLessThanOrEqual(4);
  });
});

// ────────────────────────────────────────────────────────────
// runPhase1 — integration with retry_ladder split semantics
// ────────────────────────────────────────────────────────────

describe("runPhase1 — split-and-retry integration", () => {
  it("LLM fails depth-0 but succeeds depth-1: splits batch in half, both halves emit edges", async () => {
    // Mock LLM: throws when batch.length > 2; succeeds with one-group response otherwise.
    const llm: Phase1RawLlmCall = async (prompt) => {
      const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
      if (ids > 2) throw new Error("batch too large");
      const groups = [Array.from({ length: ids }, (_, i) => i + 1)];
      return JSON.stringify({ groups });
    };
    const r = await runPhase1(
      {
        items: items(4),
        policy: basePolicy({ batch_size: 100, compute_embeddings: false }),
        budget: { remaining: 50 },
      },
      llm,
    );
    // After split, 2 sub-batches of 2 items each, each grouped as a pair → 2 edges total.
    expect(r.failed).toEqual([]);
    expect(r.edges).toHaveLength(2);
  });

  it("response_schema-conformant Phase1Response wired through the LLM call survives the retry ladder", async () => {
    const llm: Phase1RawLlmCall = async (prompt) => {
      const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
      const resp: Phase1Response = {
        groups: Array.from({ length: ids }, (_, i) => [i + 1]),
      };
      return JSON.stringify(resp);
    };
    const inputs: Phase1Inputs = {
      items: items(3),
      policy: basePolicy({ batch_size: 100, compute_embeddings: false }),
      budget: { remaining: 50 },
    };
    const r = await runPhase1(inputs, llm);
    expect(r.failed).toEqual([]);
    expect(r.edges).toEqual([]);
    expect(r.batchesSucceeded).toBe(1);
  });
});
