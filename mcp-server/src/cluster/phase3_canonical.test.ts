// Unit tests for phase3_canonical.ts (TRDD-220ea89f §7 Phase 3 LLM mode).

import { describe, it, expect } from "vitest";
import {
  buildPhase3Prompt,
  pickHeuristicCanonical,
  Phase3ResponseSchema,
  runPhase3Llm,
} from "./phase3_canonical.js";
import type { Phase1RawLlmCall } from "./phase1_batch.js";
import type { ClusterPolicy } from "./types.js";

function basePolicy(overrides: Partial<ClusterPolicy> = {}): ClusterPolicy {
  return {
    batch_size: 300,
    passes: 1,
    neighborhood_strategy: "embedding-cluster",
    max_cluster_size: 500,
    budget_max_llm_calls: 2000,
    embedding_model: "test",
    compute_embeddings: false,
    checkpoint_every: 100,
    canonical_label_mode: "llm",
    max_retries_per_attempt: 3,
    max_split_depth: 3,
    skip_preflight_benchmark: true,
    merge_min_cross_count: 3,
    overwrite_output: true,
    emit_sqlite_clusters: false,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// pickHeuristicCanonical
// ────────────────────────────────────────────────────────────

describe("pickHeuristicCanonical", () => {
  it("picks shortest non-empty", () => {
    expect(pickHeuristicCanonical(["compile", "compile the code", "compile c"])).toBe("compile");
  });
  it("ties on length broken by lex order", () => {
    expect(pickHeuristicCanonical(["banana", "apple", "carrot"])).toBe("apple");
  });
  it("empty input returns empty string", () => {
    expect(pickHeuristicCanonical([])).toBe("");
  });
});

// ────────────────────────────────────────────────────────────
// buildPhase3Prompt
// ────────────────────────────────────────────────────────────

describe("buildPhase3Prompt", () => {
  it("contains the canonical-form rule + JSON output instruction", () => {
    const p = buildPhase3Prompt(["a", "b"]);
    expect(p).toContain("CLEANEST canonical form");
    expect(p).toContain('"canonical"');
    expect(p).toContain('"rationale"');
    expect(p).toContain("- a");
    expect(p).toContain("- b");
    expect(p).toContain("MUST be one of the input sentences verbatim");
  });
  it("newlines in sentences replaced so each list entry stays one line", () => {
    const p = buildPhase3Prompt(["hello\nworld"]);
    expect(p).toContain("- hello world");
    expect(p).not.toContain("- hello\nworld");
  });
});

// ────────────────────────────────────────────────────────────
// Phase3ResponseSchema
// ────────────────────────────────────────────────────────────

describe("Phase3ResponseSchema", () => {
  it("accepts well-formed responses", () => {
    expect(Phase3ResponseSchema.parse({ canonical: "x", rationale: "y" }))
      .toEqual({ canonical: "x", rationale: "y" });
  });
  it("rejects empty canonical", () => {
    expect(() => Phase3ResponseSchema.parse({ canonical: "", rationale: "y" })).toThrow();
  });
  it("rejects missing rationale", () => {
    expect(() => Phase3ResponseSchema.parse({ canonical: "x" })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────
// runPhase3Llm
// ────────────────────────────────────────────────────────────

function llmThatPicksFirstAlphabetical(): Phase1RawLlmCall {
  return async (prompt: string) => {
    // Extract sentences from the "- xxx" lines.
    const matches = prompt.match(/^- (.+)$/gm) ?? [];
    const sentences = matches.map((m) => m.slice(2));
    const sorted = sentences.slice().sort();
    return JSON.stringify({ canonical: sorted[0], rationale: "shortest by lex order" });
  };
}

describe("runPhase3Llm", () => {
  it("singleton cluster: heuristic answer, ZERO LLM calls", async () => {
    const r = await runPhase3Llm(
      {
        clusters: [{ clusterId: "c1", sentences: ["only one"] }],
        policy: basePolicy(),
        budget: { remaining: 100 },
      },
      async () => {
        throw new Error("LLM should not be called for singletons");
      },
    );
    expect(r.canonicals.get("c1")).toBe("only one");
    expect(r.llmCallCount).toBe(0);
  });

  it("all-identical-sentences cluster: heuristic, ZERO LLM calls", async () => {
    const r = await runPhase3Llm(
      {
        clusters: [{ clusterId: "c1", sentences: ["dup", "dup", "dup"] }],
        policy: basePolicy(),
        budget: { remaining: 100 },
      },
      async () => {
        throw new Error("LLM should not be called for all-identical");
      },
    );
    expect(r.canonicals.get("c1")).toBe("dup");
    expect(r.llmCallCount).toBe(0);
  });

  it("multi-sentence cluster: ONE LLM call; canonical wins as returned", async () => {
    const r = await runPhase3Llm(
      {
        clusters: [{ clusterId: "c1", sentences: ["zebra", "apple", "mango"] }],
        policy: basePolicy(),
        budget: { remaining: 100 },
      },
      llmThatPicksFirstAlphabetical(),
    );
    expect(r.canonicals.get("c1")).toBe("apple");
    expect(r.llmCallCount).toBe(1);
  });

  it("LLM hallucinates a NEW string → validation fails → heuristic kept + warning emitted", async () => {
    const llm: Phase1RawLlmCall = async () =>
      JSON.stringify({ canonical: "totally made up", rationale: "I invented this" });
    const r = await runPhase3Llm(
      {
        clusters: [{ clusterId: "c1", sentences: ["short", "much longer sentence"] }],
        policy: basePolicy(),
        budget: { remaining: 100 },
      },
      llm,
    );
    expect(r.canonicals.get("c1")).toBe("short"); // heuristic = shortest
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/cluster c1.*falling back to heuristic/);
  });

  it("LLM throws → retries exhausted → heuristic kept + warning", async () => {
    const llm: Phase1RawLlmCall = async () => {
      throw new Error("network");
    };
    const r = await runPhase3Llm(
      {
        clusters: [{ clusterId: "c1", sentences: ["short", "much longer"] }],
        policy: basePolicy(),
        budget: { remaining: 100 },
      },
      llm,
    );
    expect(r.canonicals.get("c1")).toBe("short");
    expect(r.warnings[0]).toMatch(/network|failed/);
  });

  it("budget exhaustion mid-Phase-3: remaining clusters get heuristic, no further LLM calls", async () => {
    let calls = 0;
    const llm: Phase1RawLlmCall = async (prompt) => {
      calls += 1;
      const matches = prompt.match(/^- (.+)$/gm) ?? [];
      const first = matches[0] ?? "- ";
      return JSON.stringify({ canonical: first.slice(2), rationale: "first" });
    };
    const r = await runPhase3Llm(
      {
        clusters: [
          { clusterId: "c1", sentences: ["A", "AA"] },
          { clusterId: "c2", sentences: ["B", "BB"] },
          { clusterId: "c3", sentences: ["C", "CC"] },
        ],
        policy: basePolicy(),
        budget: { remaining: 1 }, // only one LLM call allowed
      },
      llm,
    );
    expect(r.canonicals.size).toBe(3);
    expect(r.budgetExhausted).toBe(true);
    expect(calls).toBeLessThanOrEqual(1);
    // First cluster gets LLM answer; remaining two get heuristic.
    expect(r.canonicals.get("c1")).toBeDefined();
    expect(r.canonicals.get("c2")).toBe("B");
    expect(r.canonicals.get("c3")).toBe("C");
  });

  it("empty clusters array → empty result, ZERO LLM calls", async () => {
    const r = await runPhase3Llm(
      { clusters: [], policy: basePolicy(), budget: { remaining: 100 } },
      async () => {
        throw new Error("should not call");
      },
    );
    expect(r.canonicals.size).toBe(0);
    expect(r.llmCallCount).toBe(0);
  });
});
