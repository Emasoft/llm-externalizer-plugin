// Orchestrator for the cluster_synonyms MCP tool (TRDD-220ea89f).
// Owns the full top-level lifecycle: argument validation, JSONL load,
// optional pre-flight model gate, embedding resolution, checkpoint
// open, Phase-1 dispatch (via phase1_batch.runPhase1), union-find
// merge, and the final emission of the four output files.
//
// Phase 2 (cross-cluster verification) and Phase 3 (LLM canonical labels) are
// fully implemented and run when the budget allows; resume honors `resume_from`
// (loads and continues the checkpoint the caller points at — TRDD-66da2aa7).
// clusters.jsonl reflects phase-1 grouping refined by phase-2 merges, with
// phase-3 canonical labels surfaced in clusters_summary.json.

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";

import { CheckpointDB } from "./checkpoint.js";
import { computeEmbeddings, loadEmbeddings, type EmbeddingsBundle } from "./embeddings.js";
import { readClusterJsonl } from "./jsonl.js";
import { runPhase1, type Phase1RawLlmCall } from "./phase1_batch.js";
import { runPhase2 } from "./phase2_verify.js";
import { runPhase3Llm } from "./phase3_canonical.js";
import { PolicySchema, resolvePolicy } from "./policy.js";
import { type RetryBudget } from "./retry_ladder.js";
import type {
  ClusterInputItem,
  ClusterPolicy,
  ClusterStats,
  FailedGroup,
  WeakOverlapEvidence,
} from "./types.js";

export interface ClusterSynonymsInvocation {
  input_file: string;
  output_dir: string;
  embeddings_file?: string;
  policy_file?: string;
  resume_from?: string;
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

export interface ClusterSynonymsHooks {
  /** LLM transport: prompt in, raw response text out. The orchestrator
   *  wraps this in Phase 1's JSON / schema / size validators. */
  rawLlmCall: Phase1RawLlmCall;
  /** Optional pre-flight model-gate override (skip in tests). */
  preflight?: () => Promise<PreflightResult>;
  /** Optional embeddings provider override. Receives the loaded items
   *  and returns a bundle or `undefined` (fall back to random batching). */
  embeddingsProvider?: (items: ClusterInputItem[]) => Promise<EmbeddingsBundle | undefined>;
  /** Path to compute_embeddings.py — defaulted by the caller (index.ts
   *  knows the plugin install root via __dirname). Only consulted when
   *  embeddingsProvider isn't supplied. */
  embeddingsScriptPath?: string;
  /** Profile name to embed in stats.json. */
  profileName?: string;
}

export interface ClusterSynonymsResult {
  ok: boolean;
  output_dir: string;
  clusters_jsonl: string;
  clusters_summary_json: string;
  stats_json: string;
  checkpoint_sqlite: string;
  stats: ClusterStats;
  /** Hard errors that aborted the run before Phase 4. Empty when ok. */
  errors: string[];
}

export interface ClusterEntry {
  cluster_id: string;
  size: number;
  canonical: string;
  items: { id: string; sentence: string }[];
}

export interface ClustersSummary {
  generated_at: string;
  items_in: number;
  clusters_out: number;
  reduction_pct: number;
  profile_name: string;
  clusters: ClusterEntry[];
}

const OUTPUT_NAMES = {
  clusters: "clusters.jsonl",
  summary: "clusters_summary.json",
  stats: "stats.json",
  checkpoint: "checkpoint.sqlite",
} as const;

/** Result of the JSONL load pass — items plus any per-line warnings
 *  (T7 — malformed lines are skipped + logged, not fatal). Delegates to
 *  readClusterJsonl which already iterates streamJsonl, validates each
 *  row via asClusterItem, and dedupes ids. */
async function loadInputJsonl(path: string): Promise<{
  items: ClusterInputItem[];
  warnings: string[];
}> {
  if (!existsSync(path)) {
    throw new Error(`input_file not found: ${path}`);
  }
  return readClusterJsonl(path);
}

/** Load policy from a JSON file or return defaults. */
function loadPolicy(policyFile: string | undefined): ClusterPolicy {
  if (!policyFile) return resolvePolicy(undefined);
  if (!existsSync(policyFile)) {
    throw new Error(`policy_file not found: ${policyFile}`);
  }
  const raw = readFileSync(policyFile, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy_file is not valid JSON: ${policyFile}: ${(err as Error).message}`, { cause: err });
  }
  const valid = PolicySchema.parse(parsed);
  return resolvePolicy(valid);
}

/** T13/T14: refuse to clobber an existing output dir unless
 *  overwrite_output OR the dir is empty / nonexistent / a resume run. */
function gateOutputDir(outputDir: string, policy: ClusterPolicy, resuming: boolean): void {
  mkdirSync(outputDir, { recursive: true });
  if (resuming) return;
  const existing = readdirSync(outputDir).filter((n) => !n.startsWith("."));
  const collisions = existing.filter((n) =>
    Object.values(OUTPUT_NAMES).includes(n as (typeof OUTPUT_NAMES)[keyof typeof OUTPUT_NAMES]),
  );
  if (collisions.length === 0) return;
  if (!policy.overwrite_output) {
    throw new Error(
      `output_dir ${outputDir} already contains ${collisions.join(", ")}; ` +
        `set policy.overwrite_output=true or pass resume_from to continue`,
    );
  }
}

/** Default embeddings provider: precomputed-file first, else Python sidecar. */
async function defaultEmbeddingsProvider(
  items: ClusterInputItem[],
  invocation: ClusterSynonymsInvocation,
  policy: ClusterPolicy,
  scriptPath?: string,
  warnings?: string[],
): Promise<EmbeddingsBundle | undefined> {
  if (invocation.embeddings_file) {
    // T5: dim/N mismatch raises a hard error.
    return loadEmbeddings(invocation.embeddings_file, items.length);
  }
  if (!policy.compute_embeddings) return undefined;
  if (!scriptPath) {
    warnings?.push("embeddings: compute_embeddings=true but no script path provided — falling back to random batching");
    return undefined;
  }
  try {
    return computeEmbeddings(items, {
      outDir: invocation.output_dir,
      model: policy.embedding_model,
      scriptPath,
    });
  } catch (err) {
    warnings?.push(
      `embeddings: sidecar failed (${(err as Error).message}); falling back to random batching`,
    );
    return undefined;
  }
}

/** Cluster-id selection. Use the deterministic-sorted minimum item id of
 *  each component as its persistent id. This means the same partition
 *  always reports the same cluster_id, irrespective of union order
 *  (idempotency under re-run, T10). */
function chooseClusterId(items: string[]): string {
  let min = items[0];
  for (let i = 1; i < items.length; i++) {
    if (items[i] < min) min = items[i];
  }
  return min;
}

/** Heuristic canonical label: shortest non-empty sentence in the cluster,
 *  ties broken by lexicographic order on the original sentence. */
function pickHeuristicCanonical(sentences: string[]): string {
  if (sentences.length === 0) return "";
  let best = sentences[0];
  for (let i = 1; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.length < best.length || (s.length === best.length && s < best)) best = s;
  }
  return best;
}

function reductionPct(itemsIn: number, clustersOut: number): number {
  if (itemsIn === 0) return 0;
  return ((itemsIn - clustersOut) / itemsIn) * 100;
}

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8" });
  renameSync(tmp, path);
}

function writeClustersJsonl(
  path: string,
  itemsById: Map<string, ClusterInputItem>,
  partition: Map<string, string[]>,
): void {
  // partition is computed ONCE by the caller (B5, TRDD-66da2aa7) and shared
  // with buildSummary + the phase-3 branch — it used to be rebuilt here.
  const lines: string[] = [];
  // Stable iteration order: sort cluster ids, sort items inside each.
  const sortedRoots = Array.from(partition.keys()).sort();
  for (const root of sortedRoots) {
    const members = (partition.get(root) ?? []).slice().sort();
    const clusterId = chooseClusterId(members);
    for (const m of members) {
      const it = itemsById.get(m);
      if (!it) continue;
      lines.push(JSON.stringify({ id: it.id, cluster_id: clusterId, sentence: it.sentence }));
    }
  }
  writeFileSync(path, lines.join("\n") + (lines.length ? "\n" : ""), { encoding: "utf-8" });
}

function buildSummary(
  itemsById: Map<string, ClusterInputItem>,
  partition: Map<string, string[]>,
  profileName: string,
  canonicalsOverride?: Map<string, string>,
): ClustersSummary {
  // partition is computed ONCE by the caller (B5, TRDD-66da2aa7) — shared with
  // writeClustersJsonl + the phase-3 branch instead of rebuilt per emit.
  const clusters: ClusterEntry[] = [];
  const sortedRoots = Array.from(partition.keys()).sort();
  for (const root of sortedRoots) {
    const members = (partition.get(root) ?? []).slice().sort();
    if (members.length === 0) continue;
    const clusterId = chooseClusterId(members);
    const memberItems = members
      .map((id) => itemsById.get(id))
      .filter((it): it is ClusterInputItem => it !== undefined);
    // Prefer the LLM-computed canonical when Phase 3 produced one;
    // fall back to the heuristic for any cluster that wasn't sent to
    // Phase 3 (singletons, all-identical, or budget-exhausted).
    const overrideCanonical = canonicalsOverride?.get(clusterId);
    const canonical = overrideCanonical
      ?? pickHeuristicCanonical(memberItems.map((it) => it.sentence));
    clusters.push({
      cluster_id: clusterId,
      size: memberItems.length,
      canonical,
      items: memberItems.map((it) => ({ id: it.id, sentence: it.sentence })),
    });
  }
  // Sort clusters by size desc so the user sees biggest concepts first.
  clusters.sort((a, b) => b.size - a.size || a.cluster_id.localeCompare(b.cluster_id));
  return {
    generated_at: new Date().toISOString(),
    items_in: itemsById.size,
    clusters_out: clusters.length,
    reduction_pct: reductionPct(itemsById.size, clusters.length),
    profile_name: profileName,
    clusters,
  };
}

export async function runClusterSynonyms(
  invocation: ClusterSynonymsInvocation,
  hooks: ClusterSynonymsHooks,
): Promise<ClusterSynonymsResult> {
  const tStart = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const profileName = hooks.profileName ?? "unknown";

  // 1. Policy + input gate.
  const policy = loadPolicy(invocation.policy_file);
  const resumeFrom = invocation.resume_from;
  const resuming = resumeFrom !== undefined;
  // B2 (TRDD-66da2aa7): a resume run bypasses the output-dir non-empty guard,
  // so a `resume_from` that doesn't exist must NOT fall through to a
  // from-scratch run that then overwrites the output dir. Fail fast instead.
  if (resumeFrom !== undefined && !existsSync(resumeFrom)) {
    errors.push(`resume_from checkpoint not found: ${resumeFrom}`);
    return buildEarlyAbort(invocation, errors, warnings, profileName, tStart);
  }

  // 2. Load items (T7 — malformed-line tolerance).
  const { items, warnings: jsonlWarnings } = await loadInputJsonl(invocation.input_file);
  warnings.push(...jsonlWarnings);
  if (items.length === 0) {
    // T8 — all-blank input is a hard error, no Phase 0 work.
    errors.push("no valid input rows in input_file");
    return buildEarlyAbort(invocation, errors, warnings, profileName, tStart);
  }
  const itemsById = new Map<string, ClusterInputItem>();
  for (const it of items) itemsById.set(it.id, it);

  // 3. T13 / T14 — output-dir gate.
  try {
    gateOutputDir(invocation.output_dir, policy, resuming);
  } catch (err) {
    errors.push((err as Error).message);
    return buildEarlyAbort(invocation, errors, warnings, profileName, tStart);
  }

  // 4. Pre-flight benchmark gate (Q11 — opt out via policy or hook).
  if (hooks.preflight && !policy.skip_preflight_benchmark) {
    const pf = await hooks.preflight();
    if (!pf.ok) {
      errors.push(`pre-flight benchmark gate failed: ${pf.reason}`);
      return buildEarlyAbort(invocation, errors, warnings, profileName, tStart);
    }
  }

  // 5. Embeddings.
  let bundle: EmbeddingsBundle | undefined;
  try {
    bundle = hooks.embeddingsProvider
      ? await hooks.embeddingsProvider(items)
      : await defaultEmbeddingsProvider(items, invocation, policy, hooks.embeddingsScriptPath, warnings);
  } catch (err) {
    errors.push(`embeddings: ${(err as Error).message}`);
    return buildEarlyAbort(invocation, errors, warnings, profileName, tStart);
  }

  // 6. Checkpoint. B2 (TRDD-66da2aa7): when resuming, load (and continue
  // writing) the checkpoint the caller pointed at via resume_from — its VALUE
  // used to be ignored, so "resume" loaded an empty output_dir checkpoint and
  // re-clustered from scratch over the existing outputs. Fresh runs still use
  // output_dir/checkpoint.sqlite.
  const checkpointPath = resumeFrom ?? join(invocation.output_dir, OUTPUT_NAMES.checkpoint);
  const ckpt = CheckpointDB.open(checkpointPath);
  const uf = ckpt.loadUnionFind();
  for (const it of items) uf.add(it.id);

  // 7. Phase 1.
  const budget: RetryBudget = { remaining: policy.budget_max_llm_calls };
  const phase1 = await runPhase1(
    {
      items,
      embeddings: bundle?.embeddings,
      dim: bundle?.dim,
      policy,
      budget,
    },
    hooks.rawLlmCall,
  );
  warnings.push(...phase1.warnings);
  for (const e of phase1.edges) uf.union(e.a, e.b);

  // 8. Phase 2 — cross-cluster verification (Q12 ≥3-floor merge rule).
  //    Only runs when the budget isn't already exhausted by Phase 1; T9
  //    expects Phase 2 to abort cleanly in that case.
  let weakOverlapEvidence: WeakOverlapEvidence[] = [];
  let phase2Failed: FailedGroup[] = [];
  let phase2Calls = 0;
  let phase2Merges: Array<[string, string]> = [];
  if (!phase1.budgetExhausted && items.length >= 2) {
    const phase2 = await runPhase2(
      {
        items,
        embeddings: bundle?.embeddings,
        dim: bundle?.dim,
        uf,
        policy,
        budget,
      },
      hooks.rawLlmCall,
    );
    warnings.push(...phase2.warnings);
    weakOverlapEvidence = phase2.weakOverlapEvidence;
    phase2Failed = phase2.failed;
    phase2Calls = phase2.llmCallCount;
    phase2Merges = phase2.mergedPairs;
  } else if (phase1.budgetExhausted) {
    warnings.push("phase2 skipped: budget exhausted in phase 1");
  }

  // uf is final here — phase-1 edges and phase-2 merges are all applied in
  // place (runPhase2 unions merged pairs). Compute the partition ONCE and share
  // it with phase 3 + both emitters (B5, TRDD-66da2aa7).
  const partition = uf.partition();

  // 9. Phase 3 — canonical labels. Heuristic mode is computed inline
  //    by buildSummary; LLM mode runs one call per non-trivial cluster
  //    (singletons + all-identical clusters skip the LLM) and the result
  //    overrides the heuristic in the summary.
  let phase3Calls = 0;
  let canonicalsOverride: Map<string, string> | undefined;
  if (policy.canonical_label_mode === "llm" && budget.remaining > 0) {
    const phase3Clusters = Array.from(partition.entries()).map(([_root, members]) => {
      const clusterId = chooseClusterId(members.slice().sort());
      const sentences = members
        .map((id) => itemsById.get(id)?.sentence)
        .filter((s): s is string => typeof s === "string");
      return { clusterId, sentences };
    });
    const phase3 = await runPhase3Llm(
      { clusters: phase3Clusters, policy, budget },
      hooks.rawLlmCall,
    );
    phase3Calls = phase3.llmCallCount;
    warnings.push(...phase3.warnings);
    canonicalsOverride = phase3.canonicals;
  } else if (policy.canonical_label_mode === "llm" && budget.remaining <= 0) {
    warnings.push("phase3 skipped: budget exhausted before LLM canonical mode could run");
  }

  // 10. Persist checkpoint.
  ckpt.saveUnionFind(uf);
  ckpt.setMeta("profile_name", profileName);
  ckpt.setMeta("policy_json", JSON.stringify(policy));
  ckpt.setMeta("items_in", String(items.length));
  ckpt.setMeta("phase1_llm_calls", String(phase1.llmCallCount));
  ckpt.setMeta("phase2_llm_calls", String(phase2Calls));
  ckpt.setMeta("phase2_merges", String(phase2Merges.length));
  ckpt.setMeta("phase3_llm_calls", String(phase3Calls));
  ckpt.close();

  // 11. Stats.
  const failed: FailedGroup[] = [...phase1.failed, ...phase2Failed];
  const stats: ClusterStats = {
    items_in: items.length,
    clusters_out: uf.numClusters(),
    reduction_pct: reductionPct(items.length, uf.numClusters()),
    llm_calls_total: phase1.llmCallCount + phase2Calls + phase3Calls,
    llm_calls_by_phase: { phase1: phase1.llmCallCount, phase2: phase2Calls, phase3: phase3Calls },
    tokens_total: 0, // populated when the LLM transport surfaces token usage
    walltime_seconds: (Date.now() - tStart) / 1000,
    profile_name: profileName,
    budget_exhausted: budget.remaining <= 0 || phase1.budgetExhausted,
    failed_groups: failed,
    weak_overlap_evidence: weakOverlapEvidence,
    warnings,
  };

  // 12. Emit outputs.
  const clustersPath = join(invocation.output_dir, OUTPUT_NAMES.clusters);
  const summaryPath = join(invocation.output_dir, OUTPUT_NAMES.summary);
  const statsPath = join(invocation.output_dir, OUTPUT_NAMES.stats);
  writeClustersJsonl(clustersPath, itemsById, partition);
  writeJsonAtomic(summaryPath, buildSummary(itemsById, partition, profileName, canonicalsOverride));
  writeJsonAtomic(statsPath, stats);

  return {
    ok: true,
    output_dir: invocation.output_dir,
    clusters_jsonl: clustersPath,
    clusters_summary_json: summaryPath,
    stats_json: statsPath,
    checkpoint_sqlite: checkpointPath,
    stats,
    errors: [],
  };
}

function buildEarlyAbort(
  invocation: ClusterSynonymsInvocation,
  errors: string[],
  warnings: string[],
  profileName: string,
  tStart: number,
): ClusterSynonymsResult {
  const stats: ClusterStats = {
    items_in: 0,
    clusters_out: 0,
    reduction_pct: 0,
    llm_calls_total: 0,
    llm_calls_by_phase: { phase1: 0, phase2: 0, phase3: 0 },
    tokens_total: 0,
    walltime_seconds: (Date.now() - tStart) / 1000,
    profile_name: profileName,
    budget_exhausted: false,
    failed_groups: [],
    weak_overlap_evidence: [],
    warnings: [...warnings, ...errors],
  };
  return {
    ok: false,
    output_dir: invocation.output_dir,
    clusters_jsonl: "",
    clusters_summary_json: "",
    stats_json: "",
    checkpoint_sqlite: "",
    stats,
    errors,
  };
}
