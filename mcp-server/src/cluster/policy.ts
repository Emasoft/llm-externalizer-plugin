// Zod schema + defaults for the cluster_synonyms policy block. The schema
// is the SINGLE source of truth for what knobs exist — both the JSON
// Schema (in buildTools()) and the runtime parser route through here.
//
// All policy fields are optional in the JSON; defaults below match §2 of
// the TRDD (TRDD-220ea89f). The schema uses `looseObject` so unknown
// future fields are forwarded harmlessly (no Zod 4 deprecation noise).

import { z } from "zod";
import type { ClusterPolicy } from "./types.js";

export const DEFAULT_POLICY: ClusterPolicy = {
  batch_size: 300,
  passes: 3,
  neighborhood_strategy: "embedding-cluster",
  max_cluster_size: 500,
  budget_max_llm_calls: 2000,
  embedding_model: "sentence-transformers/all-MiniLM-L6-v2",
  compute_embeddings: true,
  checkpoint_every: 100,
  canonical_label_mode: "heuristic",
  max_retries_per_attempt: 3,
  max_split_depth: 3,
  skip_preflight_benchmark: false,
  merge_min_cross_count: 3,
  overwrite_output: false,
  emit_sqlite_clusters: true,
};

export const PolicySchema = z.looseObject({
  batch_size: z.number().int().positive().optional(),
  passes: z.number().int().positive().optional(),
  neighborhood_strategy: z.enum(["random", "embedding-cluster", "hybrid"]).optional(),
  max_cluster_size: z.number().int().positive().optional(),
  budget_max_llm_calls: z.number().int().positive().optional(),
  embedding_model: z.string().optional(),
  compute_embeddings: z.boolean().optional(),
  checkpoint_every: z.number().int().positive().optional(),
  canonical_label_mode: z.enum(["heuristic", "llm"]).optional(),
  max_retries_per_attempt: z.number().int().positive().optional(),
  max_split_depth: z.number().int().min(0).max(8).optional(),
  skip_preflight_benchmark: z.boolean().optional(),
  merge_min_cross_count: z.number().int().min(1).optional(),
  overwrite_output: z.boolean().optional(),
  emit_sqlite_clusters: z.boolean().optional(),
});

export type PolicyInput = z.infer<typeof PolicySchema>;

export function resolvePolicy(raw: PolicyInput | undefined): ClusterPolicy {
  const r = raw ?? {};
  return {
    batch_size: r.batch_size ?? DEFAULT_POLICY.batch_size,
    passes: r.passes ?? DEFAULT_POLICY.passes,
    neighborhood_strategy: r.neighborhood_strategy ?? DEFAULT_POLICY.neighborhood_strategy,
    max_cluster_size: r.max_cluster_size ?? DEFAULT_POLICY.max_cluster_size,
    budget_max_llm_calls: r.budget_max_llm_calls ?? DEFAULT_POLICY.budget_max_llm_calls,
    embedding_model: r.embedding_model ?? DEFAULT_POLICY.embedding_model,
    compute_embeddings: r.compute_embeddings ?? DEFAULT_POLICY.compute_embeddings,
    checkpoint_every: r.checkpoint_every ?? DEFAULT_POLICY.checkpoint_every,
    canonical_label_mode: r.canonical_label_mode ?? DEFAULT_POLICY.canonical_label_mode,
    max_retries_per_attempt: r.max_retries_per_attempt ?? DEFAULT_POLICY.max_retries_per_attempt,
    max_split_depth: r.max_split_depth ?? DEFAULT_POLICY.max_split_depth,
    skip_preflight_benchmark: r.skip_preflight_benchmark ?? DEFAULT_POLICY.skip_preflight_benchmark,
    merge_min_cross_count: r.merge_min_cross_count ?? DEFAULT_POLICY.merge_min_cross_count,
    overwrite_output: r.overwrite_output ?? DEFAULT_POLICY.overwrite_output,
    emit_sqlite_clusters: r.emit_sqlite_clusters ?? DEFAULT_POLICY.emit_sqlite_clusters,
  };
}
