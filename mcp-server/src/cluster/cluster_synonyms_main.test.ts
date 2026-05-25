// Orchestrator tests for cluster_synonyms (TRDD-220ea89f T1, T2, T3,
// T6, T7, T8, T10, T13, T14). LLM call is mocked; pre-flight hook is
// omitted; embeddings provider is the default (no embeddings_file +
// compute_embeddings=false → random batching path, no Python invocation).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runClusterSynonyms, type ClusterSynonymsHooks } from "./cluster_synonyms_main.js";
import type { Phase1RawLlmCall } from "./phase1_batch.js";
import { CheckpointDB } from "./checkpoint.js";
import { UnionFind } from "./unionfind.js";

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cs-main-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeJsonl(rows: unknown[]): string {
  const path = join(tmp, "in.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

function items(n: number, prefix = "item"): { id: string; sentence: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}`, sentence: `sentence ${i}` }));
}

/** LLM mock: every item is a singleton group. Result: no edges. */
function singletonLlm(): Phase1RawLlmCall {
  return async (prompt) => {
    const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
    return JSON.stringify({ groups: Array.from({ length: ids }, (_, i) => [i + 1]) });
  };
}

/** LLM mock: groups consecutive pairs (1,2)(3,4)... */
function pairGroupsLlm(): Phase1RawLlmCall {
  return async (prompt) => {
    const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
    const groups: number[][] = [];
    for (let i = 0; i < ids; i += 2) {
      groups.push(i + 1 < ids ? [i + 1, i + 2] : [i + 1]);
    }
    return JSON.stringify({ groups });
  };
}

/** LLM mock: one giant group containing every id. Result: union all. */
function allOneGroupLlm(): Phase1RawLlmCall {
  return async (prompt) => {
    const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
    return JSON.stringify({ groups: [Array.from({ length: ids }, (_, i) => i + 1)] });
  };
}

function baseHooks(rawLlmCall: Phase1RawLlmCall): ClusterSynonymsHooks {
  return {
    rawLlmCall,
    profileName: "test-profile",
  };
}

// ────────────────────────────────────────────────────────────
// T1 — identity clusters
// ────────────────────────────────────────────────────────────

describe("T1 — identity clusters", () => {
  it("10 unique items, LLM says all singletons → 10 clusters, no merges", async () => {
    const inputPath = writeJsonl(items(10));
    const outDir = join(tmp, "out");
    const policyPath = join(tmp, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ compute_embeddings: false, batch_size: 5 }));

    const r = await runClusterSynonyms(
      { input_file: inputPath, output_dir: outDir, policy_file: policyPath },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.items_in).toBe(10);
    expect(r.stats.clusters_out).toBe(10);
    expect(r.stats.reduction_pct).toBe(0);
    expect(r.errors).toEqual([]);
    // Output files present.
    expect(existsSync(r.clusters_jsonl)).toBe(true);
    expect(existsSync(r.clusters_summary_json)).toBe(true);
    expect(existsSync(r.stats_json)).toBe(true);
    expect(existsSync(r.checkpoint_sqlite)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// T2 — pure synonyms (pair groups)
// ────────────────────────────────────────────────────────────

describe("T2 — pure synonyms", () => {
  it("6 items, LLM pairs (1,2)(3,4)(5,6) → 3 clusters of size 2 each", async () => {
    const inputPath = writeJsonl(items(6));
    const outDir = join(tmp, "out");
    const policyPath = join(tmp, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ compute_embeddings: false, batch_size: 100 }));

    const r = await runClusterSynonyms(
      { input_file: inputPath, output_dir: outDir, policy_file: policyPath },
      baseHooks(pairGroupsLlm()),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.items_in).toBe(6);
    expect(r.stats.clusters_out).toBe(3);
    const summary = JSON.parse(readFileSync(r.clusters_summary_json, "utf-8"));
    expect(summary.clusters).toHaveLength(3);
    for (const c of summary.clusters) {
      expect(c.size).toBe(2);
      expect(c.canonical).toBeTypeOf("string");
      expect(c.canonical.length).toBeGreaterThan(0);
    }
  });
});

// ────────────────────────────────────────────────────────────
// T7 — malformed JSONL lines are tolerated, logged in warnings
// ────────────────────────────────────────────────────────────

describe("T7 — malformed JSONL line tolerated", () => {
  it("3 valid + 1 missing-sentence + 1 invalid JSON → 3 clusters, 2 warnings", async () => {
    const inputPath = join(tmp, "in.jsonl");
    writeFileSync(
      inputPath,
      [
        JSON.stringify({ id: "a", sentence: "alpha" }),
        JSON.stringify({ id: "b" }), // missing sentence
        "this is not json",
        JSON.stringify({ id: "c", sentence: "gamma" }),
        JSON.stringify({ id: "d", sentence: "delta" }),
      ].join("\n") + "\n",
    );
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 100 }),
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.items_in).toBe(3);
    expect(r.stats.warnings.length).toBeGreaterThanOrEqual(2);
    // At least one warning about missing sentence, one about invalid JSON.
    const allWarnings = r.stats.warnings.join("\n");
    expect(allWarnings).toMatch(/missing.+sentence|sentence.+missing|empty 'sentence'/i);
  });
});

// ────────────────────────────────────────────────────────────
// T8 — all-blank input → hard error
// ────────────────────────────────────────────────────────────

describe("T8 — all-blank input", () => {
  it("empty file → ok=false, no LLM calls, error message records 'no valid input rows'", async () => {
    const inputPath = join(tmp, "empty.jsonl");
    writeFileSync(inputPath, "");
    let llmCalls = 0;
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
      },
      {
        ...baseHooks(async () => {
          llmCalls += 1;
          return "{}";
        }),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("no valid input rows"))).toBe(true);
    expect(llmCalls).toBe(0);
    expect(r.stats.llm_calls_total).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// T6 — embedding mode skip → random batching path, warning
// ────────────────────────────────────────────────────────────

describe("T6 — embedding-mode skip", () => {
  it("compute_embeddings=false with no embeddings_file → warning, completes", async () => {
    const inputPath = writeJsonl(items(8));
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 4 }),
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.warnings.some((w) => w.includes("random batching"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// T13 / T14 — output_dir collision behavior
// ────────────────────────────────────────────────────────────

describe("T13 / T14 — output_dir collision", () => {
  it("T13: existing clusters.jsonl in output_dir, overwrite_output=false → hard error", async () => {
    const inputPath = writeJsonl(items(3));
    const outDir = join(tmp, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "clusters.jsonl"), "{}\n");
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: outDir,
        policy_file: writePolicy({ compute_embeddings: false, overwrite_output: false }),
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/already contains|overwrite_output/);
  });

  it("T14: same collision but overwrite_output=true → run completes, overwrites prior files", async () => {
    const inputPath = writeJsonl(items(3));
    const outDir = join(tmp, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "clusters.jsonl"), "{stale}\n");
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: outDir,
        policy_file: writePolicy({ compute_embeddings: false, overwrite_output: true }),
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(true);
    const clusters = readFileSync(r.clusters_jsonl, "utf-8");
    expect(clusters).not.toContain("{stale}");
    expect(clusters).toMatch(/cluster_id/);
  });
});

// ────────────────────────────────────────────────────────────
// Pre-flight gate (Q11) — hook fails → abort before any LLM call
// ────────────────────────────────────────────────────────────

describe("pre-flight gate (Q11)", () => {
  it("when preflight returns {ok:false}, run aborts with no LLM calls", async () => {
    const inputPath = writeJsonl(items(5));
    let llmCalls = 0;
    const r = await runClusterSynonyms(
      { input_file: inputPath, output_dir: join(tmp, "out") },
      {
        ...baseHooks(async () => {
          llmCalls += 1;
          return "{}";
        }),
        preflight: async () => ({ ok: false, reason: "fake broken profile" }),
      },
    );
    expect(r.ok).toBe(false);
    expect(llmCalls).toBe(0);
    expect(r.errors.join("\n")).toMatch(/pre-flight benchmark/);
  });

  it("when policy.skip_preflight_benchmark=true, the hook is NOT consulted even if provided", async () => {
    const inputPath = writeJsonl(items(3));
    let preflightCalls = 0;
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, skip_preflight_benchmark: true }),
      },
      {
        ...baseHooks(singletonLlm()),
        preflight: async () => {
          preflightCalls += 1;
          return { ok: false, reason: "should not be called" };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(preflightCalls).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// Output shape — clusters.jsonl + clusters_summary.json contracts
// ────────────────────────────────────────────────────────────

describe("output shape", () => {
  it("clusters.jsonl has one line per item with id+cluster_id+sentence", async () => {
    const inputPath = writeJsonl(items(4));
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 100 }),
      },
      baseHooks(allOneGroupLlm()),
    );
    expect(r.ok).toBe(true);
    const lines = readFileSync(r.clusters_jsonl, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(4);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(new Set(parsed.map((p) => p.cluster_id)).size).toBe(1); // all in one cluster
    for (const p of parsed) {
      expect(p).toMatchObject({ id: expect.any(String), cluster_id: expect.any(String), sentence: expect.any(String) });
    }
  });

  it("stats.json reflects per-phase llm calls; phase3 still zero (Phase 3 LLM canonical not yet wired)", async () => {
    const inputPath = writeJsonl(items(4));
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 100 }),
      },
      baseHooks(singletonLlm()),
    );
    const stats = JSON.parse(readFileSync(r.stats_json, "utf-8"));
    expect(stats.items_in).toBe(4);
    expect(stats.llm_calls_total).toBeGreaterThanOrEqual(1);
    expect(stats.llm_calls_total).toBe(
      stats.llm_calls_by_phase.phase1 + stats.llm_calls_by_phase.phase2 + stats.llm_calls_by_phase.phase3,
    );
    expect(stats.llm_calls_by_phase.phase1).toBeGreaterThanOrEqual(1);
    // Phase 2 may or may not have fired (depends on cluster count after Phase 1).
    expect(stats.llm_calls_by_phase.phase2).toBeGreaterThanOrEqual(0);
    expect(stats.llm_calls_by_phase.phase3).toBe(0);
    expect(stats.walltime_seconds).toBeGreaterThanOrEqual(0);
    expect(stats.profile_name).toBe("test-profile");
  });

  it("T10 — idempotent re-run with same inputs / overwrite=true produces same cluster_ids", async () => {
    const inputPath = writeJsonl(items(6));
    const outDir1 = join(tmp, "out1");
    const outDir2 = join(tmp, "out2");
    const policyPath = writePolicy({ compute_embeddings: false, batch_size: 100 });
    const r1 = await runClusterSynonyms(
      { input_file: inputPath, output_dir: outDir1, policy_file: policyPath },
      baseHooks(pairGroupsLlm()),
    );
    const r2 = await runClusterSynonyms(
      { input_file: inputPath, output_dir: outDir2, policy_file: policyPath },
      baseHooks(pairGroupsLlm()),
    );
    expect(r1.ok && r2.ok).toBe(true);
    const s1 = JSON.parse(readFileSync(r1.clusters_summary_json, "utf-8"));
    const s2 = JSON.parse(readFileSync(r2.clusters_summary_json, "utf-8"));
    // Compare partitions (set-of-id-sets), independent of order.
    const part = (s: typeof s1) =>
      s.clusters
        .map((c: { items: { id: string }[] }) => c.items.map((i) => i.id).sort().join(","))
        .sort();
    expect(part(s1)).toEqual(part(s2));
  });
});

// ────────────────────────────────────────────────────────────
// T3 — mixed: 5 clusters of 5 + 25 singletons
// ────────────────────────────────────────────────────────────

describe("T3 — mixed clusters", () => {
  it("50 items (5 clusters of 5 + 25 singletons): partition matches expectation when the LLM uses the id prefix as the synonym signal", async () => {
    // Build the fixture: ids c0-i0..c0-i4 are synonyms of each other, same
    // for c1..c4; ids s0..s24 are singletons.
    const rows: { id: string; sentence: string }[] = [];
    for (let c = 0; c < 5; c++) {
      for (let i = 0; i < 5; i++) {
        rows.push({ id: `c${c}-i${i}`, sentence: `concept ${c} phrasing ${i}` });
      }
    }
    for (let s = 0; s < 25; s++) {
      rows.push({ id: `s${s}`, sentence: `unique singleton ${s}` });
    }
    const inputPath = writeJsonl(rows);

    // LLM that reads the per-batch id list, recovers each item's original
    // string id from the prompt, groups items that share the "cX-" prefix,
    // and lists the rest as singletons.
    const smartLlm: Phase1RawLlmCall = async (prompt) => {
      // Extract (numId, stringId, sentence) from the prompt block.
      const re = /^(\d+)\. id=\1\s+sentence="(.+?)"/gm;
      const tuples: { num: number; sent: string }[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(prompt)) !== null) {
        tuples.push({ num: Number(m[1]), sent: m[2] });
      }
      // Group by concept prefix derived from sentence "concept X phrasing Y"
      // or fallback to per-item singleton for non-matching sentences.
      const byConcept = new Map<string, number[]>();
      const singletons: number[] = [];
      for (const t of tuples) {
        const cm = t.sent.match(/^concept (\d+) phrasing/);
        if (cm) {
          const k = `c${cm[1]}`;
          const arr = byConcept.get(k) ?? [];
          arr.push(t.num);
          byConcept.set(k, arr);
        } else {
          singletons.push(t.num);
        }
      }
      const groups: number[][] = [];
      for (const arr of byConcept.values()) groups.push(arr);
      for (const s of singletons) groups.push([s]);
      return JSON.stringify({ groups });
    };

    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 50 }),
      },
      baseHooks(smartLlm),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.items_in).toBe(50);
    // 5 concept-clusters + 25 singletons = 30 clusters.
    expect(r.stats.clusters_out).toBe(30);
    expect(r.stats.failed_groups).toEqual([]);

    // Each c-cluster has exactly 5 members.
    const summary = JSON.parse(readFileSync(r.clusters_summary_json, "utf-8"));
    const sized5 = summary.clusters.filter((c: { size: number }) => c.size === 5);
    const sized1 = summary.clusters.filter((c: { size: number }) => c.size === 1);
    expect(sized5).toHaveLength(5);
    expect(sized1).toHaveLength(25);
  });
});

// ────────────────────────────────────────────────────────────
// T11-lite smoke: 100 items, partition matches the LLM's grouping,
//                 completes in well under the 5-min Phase-B budget
// ────────────────────────────────────────────────────────────

describe("T11-lite smoke", () => {
  it("100 items, 10 ground-truth clusters of 10 → completes in <2s, exact partition in a single batch", async () => {
    // Single-batch (batch_size=100) so Phase 1 alone — without Phase 2
    // cross-cluster merging — can still emit the 10 ground-truth clusters.
    // Multi-batch coverage of the ground truth needs Phase 2 (TRDD §6.C).
    const rows: { id: string; sentence: string }[] = [];
    for (let c = 0; c < 10; c++) {
      for (let i = 0; i < 10; i++) {
        rows.push({ id: `c${c}-i${i}`, sentence: `category ${c}` });
      }
    }
    const inputPath = writeJsonl(rows);

    const llm: Phase1RawLlmCall = async (prompt) => {
      const re = /^(\d+)\. id=\1\s+sentence="(.+?)"/gm;
      const byCategory = new Map<string, number[]>();
      let m: RegExpExecArray | null;
      while ((m = re.exec(prompt)) !== null) {
        const num = Number(m[1]);
        const sent = m[2];
        const arr = byCategory.get(sent) ?? [];
        arr.push(num);
        byCategory.set(sent, arr);
      }
      const groups: number[][] = Array.from(byCategory.values());
      return JSON.stringify({ groups });
    };

    const t0 = Date.now();
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 100 }),
      },
      baseHooks(llm),
    );
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(true);
    expect(r.stats.items_in).toBe(100);
    expect(r.stats.clusters_out).toBe(10);
    expect(elapsed).toBeLessThan(2000);
  });
});

// ────────────────────────────────────────────────────────────
// Phase 3 LLM canonical mode — orchestrator integration
// ────────────────────────────────────────────────────────────

describe("Phase 3 LLM canonical mode (orchestrator integration)", () => {
  it("canonical_label_mode=llm: cluster of 2 distinct sentences gets the LLM-picked canonical", async () => {
    const inputPath = writeJsonl([
      { id: "a", sentence: "compile" },
      { id: "b", sentence: "compile the project with optimisations" },
    ]);
    // Phase 1: lump together into one cluster.
    // Phase 2: also dispatches but has only 1 cluster after phase 1, so no work.
    // Phase 3: receives the cluster, calls LLM, picks "compile" (heuristic-equivalent).
    const llm: Phase1RawLlmCall = async (prompt) => {
      // Phase 1 prompt has "id=N sentence=..." lines
      if (prompt.includes("id=1") && prompt.includes("sentence=")) {
        const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
        return JSON.stringify({ groups: [Array.from({ length: ids }, (_, i) => i + 1)] });
      }
      // Phase 3 prompt has "- sentence" lines and asks for canonical
      if (prompt.includes('"canonical"')) {
        // Pick the FIRST "- " line — the LLM's "pick the cleanest".
        const m = prompt.match(/^- (.+)$/gm) ?? [];
        return JSON.stringify({
          canonical: m[0]?.slice(2) ?? "fallback",
          rationale: "first listed",
        });
      }
      // Default: empty groups so retry-ladder eventually moves on.
      return JSON.stringify({ groups: [] });
    };
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({
          compute_embeddings: false,
          batch_size: 100,
          canonical_label_mode: "llm",
        }),
      },
      baseHooks(llm),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.llm_calls_by_phase.phase3).toBeGreaterThanOrEqual(1);
    const summary = JSON.parse(readFileSync(r.clusters_summary_json, "utf-8"));
    expect(summary.clusters).toHaveLength(1);
    // Canonical should be one of the inputs (the validator rejects hallucinations).
    expect(["compile", "compile the project with optimisations"]).toContain(
      summary.clusters[0].canonical,
    );
  });

  it("canonical_label_mode=heuristic (default): NO Phase 3 LLM calls", async () => {
    const inputPath = writeJsonl([
      { id: "a", sentence: "short" },
      { id: "b", sentence: "much longer sentence here" },
    ]);
    const llm: Phase1RawLlmCall = async (prompt) => {
      if (prompt.includes('"canonical"')) {
        throw new Error("Phase 3 LLM should NOT be called in heuristic mode");
      }
      const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
      return JSON.stringify({ groups: [Array.from({ length: ids }, (_, i) => i + 1)] });
    };
    const r = await runClusterSynonyms(
      {
        input_file: inputPath,
        output_dir: join(tmp, "out"),
        policy_file: writePolicy({
          compute_embeddings: false,
          batch_size: 100,
          canonical_label_mode: "heuristic",
        }),
      },
      baseHooks(llm),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.llm_calls_by_phase.phase3).toBe(0);
    const summary = JSON.parse(readFileSync(r.clusters_summary_json, "utf-8"));
    // Heuristic picks the shortest sentence.
    expect(summary.clusters[0].canonical).toBe("short");
  });
});

// ────────────────────────────────────────────────────────────
// T15 — Phase 2 merge rule floor (Q12)
// ────────────────────────────────────────────────────────────

describe("T15 — Phase 2 merge rule (Q12 ≥3-floor)", () => {
  it("2+2 overlap stays as two clusters; 3+3 overlap merges them", async () => {
    // Seed Phase 1 by splitting items across 2 batches so the items
    // intended-to-be-same-concept land in different Phase 1 clusters.
    // Then Phase 2's response groups them — only the 3+3 case merges.
    // We control behaviour via the mock LLM:
    //   - Phase 1 (batch_size=2): pair each batch as a singleton group
    //     (no merge inside) so each pair becomes its own cluster.
    //   - Phase 2: lumps all reps into one giant group.
    // For the 2+2 case we use 2 items per concept → 2 clusters of 2 → Phase 2 sees 2+2 → NO merge.
    // For the 3+3 case we use 3 items per concept → 2 clusters of 3 → Phase 2 sees 3+3 → MERGE.

    async function runScenario(perConcept: number, expectMerge: boolean): Promise<void> {
      const rows: { id: string; sentence: string }[] = [];
      for (let i = 0; i < perConcept; i++) rows.push({ id: `A${i}`, sentence: `concept A item ${i}` });
      for (let i = 0; i < perConcept; i++) rows.push({ id: `B${i}`, sentence: `concept B item ${i}` });
      const inputPath = writeJsonl(rows);

      // Phase 1 LLM: just emit singletons so every item becomes its own
      // cluster. Then Phase 2 sees 1-item-per-cluster and STILL can't merge
      // (the floor is 3 from each side). So singletons alone won't work —
      // we need Phase 1 to group items by concept WITHIN each batch.
      // Easier: bypass Phase 1 grouping and seed clusters via small batches.
      // Use batch_size=perConcept so each Phase-1 batch is one concept →
      // LLM lumps that batch into one group → each concept becomes a Phase-1
      // cluster of `perConcept` items.
      const llm: Phase1RawLlmCall = async (prompt) => {
        const ids = (prompt.match(/^\d+\. id=\d+/gm) ?? []).length;
        return JSON.stringify({ groups: [Array.from({ length: ids }, (_, i) => i + 1)] });
      };

      const r = await runClusterSynonyms(
        {
          input_file: inputPath,
          output_dir: join(tmp, `out-${perConcept}-${expectMerge}`),
          policy_file: writePolicy({
            compute_embeddings: false,
            batch_size: perConcept, // force 1 concept per Phase-1 batch
            passes: 1,
            merge_min_cross_count: 3,
          }),
        },
        baseHooks(llm),
      );
      expect(r.ok).toBe(true);
      if (expectMerge) {
        expect(r.stats.clusters_out).toBe(1);
        expect(r.stats.weak_overlap_evidence).toEqual([]);
      } else {
        expect(r.stats.clusters_out).toBe(2);
        // 2+2 case logs a weak-overlap row (counts of 2 each, below the 3 floor).
        expect(r.stats.weak_overlap_evidence.length).toBeGreaterThanOrEqual(1);
        expect(r.stats.weak_overlap_evidence[0]).toMatchObject({
          cross_count_a: 2, cross_count_b: 2,
        });
      }
    }

    await runScenario(2, false); // 2+2 → NO merge
    await runScenario(3, true);  // 3+3 → MERGE
  });
});

// Helper used by several tests above.
function writePolicy(p: Record<string, unknown>): string {
  const path = join(tmp, `policy-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(p));
  return path;
}

// ────────────────────────────────────────────────────────────
// B2 (TRDD-66da2aa7) — resume_from honors the checkpoint it points at.
// Pre-fix, resume_from's VALUE was ignored: the run always loaded
// output_dir/checkpoint.sqlite (empty for a fresh out dir) and re-clustered
// from scratch while the resuming flag suppressed the overwrite guard.
// ────────────────────────────────────────────────────────────

/** Seed a checkpoint at `path` whose union-find has already merged the pairs. */
function seedCheckpoint(path: string, ids: string[], unions: Array<[string, string]>): void {
  const db = CheckpointDB.open(path);
  const uf = new UnionFind();
  for (const id of ids) uf.add(id);
  for (const [a, b] of unions) uf.union(a, b);
  db.saveUnionFind(uf);
  db.close();
}

describe("B2 — resume_from is honored (data-loss footgun fixed)", () => {
  it("rehydrates the union-find from the resume_from checkpoint (merge survives)", async () => {
    // Prior run merged item-0 + item-1; the new LLM says everything is a
    // singleton. Without resume that is 4 clusters; WITH resume the prior
    // merge survives → 3 clusters. Proves resume_from's checkpoint is loaded.
    const ckptPath = join(tmp, "prior-checkpoint.sqlite");
    seedCheckpoint(ckptPath, ["item-0", "item-1"], [["item-0", "item-1"]]);

    const r = await runClusterSynonyms(
      {
        input_file: writeJsonl(items(4)),
        output_dir: join(tmp, "resumed-out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 5 }),
        resume_from: ckptPath,
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.items_in).toBe(4);
    expect(r.stats.clusters_out).toBe(3); // {item-0,item-1} + item-2 + item-3
  });

  it("without resume_from the same input clusters from scratch (4 singletons)", async () => {
    // Control: identical input + LLM, no resume → the seeded merge is absent.
    const r = await runClusterSynonyms(
      {
        input_file: writeJsonl(items(4)),
        output_dir: join(tmp, "fresh-out"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 5 }),
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(true);
    expect(r.stats.clusters_out).toBe(4);
  });

  it("a missing resume_from path fails fast instead of overwriting from scratch", async () => {
    const r = await runClusterSynonyms(
      {
        input_file: writeJsonl(items(4)),
        output_dir: join(tmp, "out-missing"),
        policy_file: writePolicy({ compute_embeddings: false, batch_size: 5 }),
        resume_from: join(tmp, "nope", "does-not-exist.sqlite"),
      },
      baseHooks(singletonLlm()),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("resume_from checkpoint not found");
    // No outputs were written (the run aborted before emit).
    expect(existsSync(join(tmp, "out-missing", "clusters.jsonl"))).toBe(false);
  });
});
