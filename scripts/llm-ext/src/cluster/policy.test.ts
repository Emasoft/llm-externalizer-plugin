// Unit tests for policy.ts (TRDD-220ea89f §2). Pure code: a zod looseObject
// schema (PolicySchema) plus a defaults-merge (resolvePolicy over
// DEFAULT_POLICY). No I/O, no network — every test exercises the real merge
// and the real schema, no mocks.

import { describe, it, expect } from "vitest";
import { resolvePolicy, DEFAULT_POLICY, PolicySchema } from "./policy.js";

describe("resolvePolicy", () => {
  it("returns every DEFAULT_POLICY value when input is undefined", () => {
    // undefined -> `r = {}` -> each field falls back to its DEFAULT_POLICY value.
    expect(resolvePolicy(undefined)).toEqual(DEFAULT_POLICY);
  });

  it("returns the defaults (not the same object reference) for an empty object", () => {
    const out = resolvePolicy({});
    expect(out).toEqual(DEFAULT_POLICY);
    // resolvePolicy builds a fresh object, so mutating the result must not
    // corrupt the shared DEFAULT_POLICY singleton.
    expect(out).not.toBe(DEFAULT_POLICY);
  });

  it("honors each individual numeric / enum / string field override", () => {
    const out = resolvePolicy({
      batch_size: 50,
      passes: 7,
      neighborhood_strategy: "hybrid",
      max_cluster_size: 99,
      budget_max_llm_calls: 10,
      embedding_model: "acme/custom-embedder",
      checkpoint_every: 25,
      canonical_label_mode: "llm",
      max_retries_per_attempt: 9,
      max_split_depth: 6,
      merge_min_cross_count: 4,
    });
    expect(out.batch_size).toBe(50);
    expect(out.passes).toBe(7);
    expect(out.neighborhood_strategy).toBe("hybrid");
    expect(out.max_cluster_size).toBe(99);
    expect(out.budget_max_llm_calls).toBe(10);
    expect(out.embedding_model).toBe("acme/custom-embedder");
    expect(out.checkpoint_every).toBe(25);
    expect(out.canonical_label_mode).toBe("llm");
    expect(out.max_retries_per_attempt).toBe(9);
    expect(out.max_split_depth).toBe(6);
    expect(out.merge_min_cross_count).toBe(4);
  });

  it("preserves explicit `false` for every boolean knob (no ?? fallback to default)", () => {
    // The booleans default to: compute_embeddings=true, emit_sqlite_clusters=true,
    // skip_preflight_benchmark=false, overwrite_output=false, skip_memory_guard=false.
    // `?? ` must keep an explicit false rather than substituting the default.
    const out = resolvePolicy({
      compute_embeddings: false,
      emit_sqlite_clusters: false,
      skip_preflight_benchmark: false,
      overwrite_output: false,
      skip_memory_guard: false,
    });
    expect(out.compute_embeddings).toBe(false);
    expect(out.emit_sqlite_clusters).toBe(false);
    expect(out.skip_preflight_benchmark).toBe(false);
    expect(out.overwrite_output).toBe(false);
    expect(out.skip_memory_guard).toBe(false);
  });

  it("flips skip_memory_guard / skip_preflight_benchmark / overwrite_output to true on request", () => {
    const out = resolvePolicy({
      skip_memory_guard: true,
      skip_preflight_benchmark: true,
      overwrite_output: true,
    });
    expect(out.skip_memory_guard).toBe(true);
    expect(out.skip_preflight_benchmark).toBe(true);
    expect(out.overwrite_output).toBe(true);
    // Untouched booleans stay at their defaults.
    expect(out.compute_embeddings).toBe(DEFAULT_POLICY.compute_embeddings);
    expect(out.emit_sqlite_clusters).toBe(DEFAULT_POLICY.emit_sqlite_clusters);
  });

  it("merges a partial input with defaults — untouched fields keep their defaults", () => {
    const out = resolvePolicy({ batch_size: 17, skip_memory_guard: true });
    expect(out.batch_size).toBe(17);
    expect(out.skip_memory_guard).toBe(true);
    // Everything else is the default.
    expect(out.passes).toBe(DEFAULT_POLICY.passes);
    expect(out.neighborhood_strategy).toBe(DEFAULT_POLICY.neighborhood_strategy);
    expect(out.embedding_model).toBe(DEFAULT_POLICY.embedding_model);
    expect(out.compute_embeddings).toBe(DEFAULT_POLICY.compute_embeddings);
    expect(out.max_split_depth).toBe(DEFAULT_POLICY.max_split_depth);
    expect(out.merge_min_cross_count).toBe(DEFAULT_POLICY.merge_min_cross_count);
  });
});

describe("PolicySchema", () => {
  it("rejects invalid field types and out-of-range values per the zod schema", () => {
    // batch_size must be a positive int -> a string fails type, 0 fails positive.
    expect(PolicySchema.safeParse({ batch_size: "lots" }).success).toBe(false);
    expect(PolicySchema.safeParse({ batch_size: 0 }).success).toBe(false);
    // neighborhood_strategy is an enum -> an unknown member fails.
    expect(PolicySchema.safeParse({ neighborhood_strategy: "telepathy" }).success).toBe(false);
    // max_split_depth is bounded int [0, 8] -> 9 is out of range.
    expect(PolicySchema.safeParse({ max_split_depth: 9 }).success).toBe(false);
    // merge_min_cross_count has min(1) -> 0 is out of range.
    expect(PolicySchema.safeParse({ merge_min_cross_count: 0 }).success).toBe(false);
    // skip_memory_guard is a boolean -> a non-boolean fails.
    expect(PolicySchema.safeParse({ skip_memory_guard: "yes" }).success).toBe(false);
  });

  it("accepts valid input, forwards unknown keys (looseObject), and feeds resolvePolicy", () => {
    const parsed = PolicySchema.parse({
      batch_size: 42,
      max_split_depth: 0, // boundary: min is 0, must be allowed
      merge_min_cross_count: 1, // boundary: min is 1, must be allowed
      skip_memory_guard: true,
      future_unknown_knob: "ignored-but-kept", // looseObject forwards this harmlessly
    });
    // looseObject keeps unknown keys instead of stripping them.
    expect((parsed as Record<string, unknown>).future_unknown_knob).toBe("ignored-but-kept");
    // The parsed object resolves correctly through the real merge path.
    const out = resolvePolicy(parsed);
    expect(out.batch_size).toBe(42);
    expect(out.max_split_depth).toBe(0);
    expect(out.merge_min_cross_count).toBe(1);
    expect(out.skip_memory_guard).toBe(true);
    // Untouched fields still default.
    expect(out.passes).toBe(DEFAULT_POLICY.passes);
  });
});
