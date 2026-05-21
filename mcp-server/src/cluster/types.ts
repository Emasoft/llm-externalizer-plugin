// Shared types for the cluster_synonyms tool. See
// design/tasks/TRDD-20260521_232551+0200-220ea89f-cluster-synonyms-mcp-tool.md
// for the full spec.
//
// The tool clusters SENTENCES (or short labels treated as sentences) by
// full-sentence meaning equivalence — NOT by word-level synonymy. The unit
// of comparison is always the complete `sentence` field, never individual
// words inside it. See §1 of the TRDD.

export interface ClusterInputItem {
  id: string;
  sentence: string;   // canonical field name; `label` accepted as alias on input
  context?: string;
}

export interface ClusterInvocation {
  input_file: string;
  output_dir: string;
  embeddings_file?: string;
  policy_file?: string;
  resume_from?: string;
}

export interface ClusterPolicy {
  // Batching
  batch_size: number;
  passes: number;
  neighborhood_strategy: "random" | "embedding-cluster" | "hybrid";
  max_cluster_size: number;
  budget_max_llm_calls: number;
  embedding_model: string;
  compute_embeddings: boolean;
  checkpoint_every: number;
  canonical_label_mode: "heuristic" | "llm";

  // Q7 — recursive split-and-retry ladder
  max_retries_per_attempt: number;   // default 3
  max_split_depth: number;           // default 3 → max 8 sub-batches at the leaf

  // Q11 — pre-flight benchmark gate
  skip_preflight_benchmark: boolean;

  // Q12 — transitive-closure merge with confidence floor
  merge_min_cross_count: number;     // default 3

  // Output / Q10
  overwrite_output: boolean;
  emit_sqlite_clusters: boolean;     // Q3 default true
}

export interface ClusterResult {
  ok: true;
  clusters_jsonl: string;
  clusters_summary_json: string;
  stats_json: string;
  checkpoint_sqlite: string;
}

export interface FailedGroup {
  // Items the recursive-split-and-retry ladder gave up on at depth 3.
  // Listed in stats.json.failed_groups so an operator can inspect or
  // re-feed them by hand. These items are NOT merged with anything.
  depth: number;
  attempt_count: number;
  item_ids: string[];
  last_error: string;
}

export interface WeakOverlapEvidence {
  // A Phase 2 response-group contained 1 or 2 cross-cluster items —
  // below the policy.merge_min_cross_count threshold. We log the pair
  // for diagnostic purposes but do NOT merge.
  response_id: string;
  cluster_a: string;
  cluster_b: string;
  cross_count_a: number;
  cross_count_b: number;
}

export interface ClusterStats {
  items_in: number;
  clusters_out: number;
  reduction_pct: number;
  llm_calls_total: number;
  llm_calls_by_phase: Record<"phase1" | "phase2" | "phase3", number>;
  tokens_total: number;
  walltime_seconds: number;
  profile_name: string;
  budget_exhausted: boolean;
  failed_groups: FailedGroup[];
  weak_overlap_evidence: WeakOverlapEvidence[];
  warnings: string[];
}
