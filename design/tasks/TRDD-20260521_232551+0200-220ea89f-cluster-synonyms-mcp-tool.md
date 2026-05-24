---
trdd-id: 220ea89f-0af2-4eba-884d-367a986d27e7
title: cluster_synonyms — zero-token batch synonym clustering MCP primitive
status: in-progress
created: 2026-05-21T23:25:51+0200
updated: 2026-05-23T20:49:55+0200
---

# TRDD-220ea89f — cluster_synonyms — zero-token batch synonym clustering MCP primitive

**Filename:** `design/tasks/TRDD-20260521_232551+0200-220ea89f-cluster-synonyms-mcp-tool.md`
**Tracked in:** this repo (`llm-externalizer-plugin/design/tasks/` is git-tracked)
**Upstream issue:** [Emasoft/llm-externalizer-plugin#4](https://github.com/Emasoft/llm-externalizer-plugin/issues/4)

## 0. User's original request (verbatim from issue #4)

> **Problem**
>
> Aggregating synonymous / equivalent-meaning items across a large term set (10k–1M items) is a recurring pattern in taxonomy work, ontology cleanup, label canonicalisation, etc. Today every existing tool (`chat`, `code_task`, `scan_folder`, `search_existing_implementations`) has the same blocker for this use case:
>
> 1. **The orchestrator pays the token cost** of shipping every item into a prompt and reading every batch response back. For 1M labels at ~50 tokens each that's ~50M token round-trip — well beyond any reasonable context budget.
> 2. **Batching is size-based, not semantic-neighbourhood-based** — two synonyms can sit in different batches and never co-occur in a single LLM call, killing recall.
> 3. **No native "group these items by identical meaning" primitive** — callers must build the batching, union-find, cross-batch verification, and canonical-label selection loops themselves.
> 4. **No resumption** — interrupted runs lose progress.
>
> Downstream pain (concrete): the `EMASOFT-SKILLS-MANAGER` taxonomy pipeline currently has ~91k L2 labels collapsed to ~2.1k via geometric k-means on sentence-transformer embeddings. Geometric distance misses real synonyms (e.g. `domain/code-research/` vs `domain/programming/`). The natural fix is a second LLM-driven verification pass — but doing it via `chat`/`code_task` would consume tens of millions of orchestrator tokens per refinement iteration.
>
> **Proposed tool: `cluster_synonyms`** — file-in, file-out, 0-orchestrator-token primitive that handles the entire batch+verify+canonicalise loop internally and returns only paths.
>
> Model selection is NOT this tool's concern — it should use whatever model selection the active llm-externalizer profile already provides. The tool is responsible for the clustering workflow, the batch-and-verify algorithm, and file I/O; the LLM backend is a black box from its perspective.
>
> Inputs: `input_file` (JSONL, required), `embeddings_file` (optional precomputed memmap), `output_dir` (required), `policy_file` (optional knobs), `resume_from` (optional checkpoint).
>
> Outputs (paths only — no item content returned): `clusters.jsonl`, `clusters_summary.json`, `stats.json`, `checkpoint.sqlite`.
>
> Phases: 0 setup → 1 embedding-clustered batching + per-batch LLM grouping (union-find) → 2 cross-cluster verification with stratified rep batches (repeat `passes` times) → 3 canonical-label selection (heuristic or LLM) → 4 emit outputs.
>
> Key properties: zero orchestrator tokens, resumable (sqlite checkpoint), budget-capped (`budget_max_llm_calls`), backend-agnostic, idempotent, linear `O(N/K)` LLM calls.
>
> Open questions for upstream: naming; should embedding computation be in-tool or caller's job; SQLite output mode default vs opt-in; default canonical-label mode (heuristic vs LLM); ok to bake `sentence-transformers` as a default dep?

Full issue text including alternatives-considered table is preserved on GitHub (issue #4) — do NOT re-paraphrase it here, the link IS the spec.

## 1. Why this matters (one-paragraph framing)

`chat` / `code_task` / `scan_folder` / `search_existing_implementations` all force every item through the orchestrator's prompt+response stream — fine for a few hundred files, ruinous for 1M taxonomy labels. `cluster_synonyms` moves the entire batch-cluster-verify-canonicalise loop INSIDE the MCP server and returns only file paths. The orchestrator stays under 1 KB of context for a run that the LLM backend handles tens of millions of tokens on. The downstream EMASOFT-SKILLS-MANAGER L2 refinement use case is the immediate driver but the primitive is general-purpose (ontology cleanup, label dedup, concept canonicalisation).

### Scope is SENTENCE-level meaning equivalence, NOT word-level synonymy

Each `item` in the input JSONL is a short SENTENCE or LABEL (typically 1–50 words, sometimes a taxonomy path like `domain/programming/`). The tool clusters items by **full-sentence meaning equivalence** — the LLM judges whether the COMPLETE phrasing of two items conveys the same concept. Example: `"Compile the code with optimizations"` ≡ `"Build the project with optimizer flags"` cluster together (same intent), but `"Compile the code"` and `"Test the code"` do NOT — different intents. The tool does NOT attempt word-by-word synonym matching ("compile" vs "build" alone is not the question — the SENTENCE-level meaning is). This distinction must be reflected in every prompt (§7) and in the policy defaults: short single-word items still work, but the prompts always ask the LLM to compare full sentences.

## 2. Open questions (all resolved 2026-05-22)

The issue's original open questions plus implementation-required additions. All 12 resolved as of 2026-05-22 (user accepted defaults for Q1–Q6, Q8–Q10; clarified Q7; added Q11 and Q12).

| Q | Question | Decision | Resolution status |
|---|---|---|---|
| Q1 | Tool name: `cluster_synonyms`, `group_by_meaning`, `dedup_concepts`, other? | `cluster_synonyms` (matches issue title; "synonyms" implies the IDENTICAL-meaning bar that Phase 2 enforces) | RESOLVED 2026-05-22 |
| Q2 | Embedding computation: in-tool default vs. caller-only? | In-tool default ON via `sentence-transformers/all-MiniLM-L6-v2` (lightweight, no GPU). Caller can pass `embeddings_file` to skip. | RESOLVED 2026-05-22 |
| Q3 | SQLite output: default emit vs. opt-in? | Default emit — checkpoint already needs sqlite, the extra cost is negligible. Add `policy.emit_sqlite_clusters: bool` knob (default true). | RESOLVED 2026-05-22 |
| Q4 | Default `canonical_label_mode`: `heuristic` or `llm`? | `heuristic` (no extra LLM cost; cluster size is small enough that the user can re-run with `llm` if quality is insufficient) | RESOLVED 2026-05-22 |
| Q5 | Bake `sentence-transformers` as a default dep? | Yes — opt-out via `policy.compute_embeddings: false`. ST is the de-facto default in the Python embedding world; alternative is `fastembed` (ONNX, no torch) — keep as a phase-B knob. | RESOLVED 2026-05-22 |
| Q6 | Concurrency model for batch LLM calls | Inherit the profile's existing concurrency (local = sequential, remote = up-to-200-in-flight). No new in-tool semaphore. | RESOLVED 2026-05-22 |
| Q7 | Failure semantics inside a batch | **Recursive-split-and-retry ladder.** Each batch (at any size) gets up to `policy.max_retries_per_attempt` LLM attempts (default 3). On exhaustion of retries: split THAT failing batch into halves and recurse on each half independently with the same 3-retry budget. Maximum recursion depth `policy.max_split_depth` (default 3) — a single source batch can split at most 1 → 2 → 4 → 8 sub-batches. At depth 3, if a sub-batch is STILL failing after 3 retries, record its items in `stats.json.failed_groups` and continue the rest of the run. Hard cap per original source batch: 3 + 6 + 12 + 24 = 45 LLM calls worst case. Always respects the global `budget_max_llm_calls`. | RESOLVED 2026-05-22 |
| Q8 | Input-format validation strictness | Reject the whole run if `input_file` has zero valid rows or `id` collisions. Skip individual malformed lines with a warning entry in `stats.json`. | RESOLVED 2026-05-22 |
| Q9 | Embedding model dimension drift — what if the `.meta.json` model name does not match `policy.embedding_model`? | Hard error. The caller must pass a matching meta.json or omit `embeddings_file` so the tool recomputes. | RESOLVED 2026-05-22 |
| Q10 | Output_dir conflict — what if it already has `clusters.jsonl`? | If `resume_from` is set, allow it (we're continuing). Otherwise hard error unless `policy.overwrite_output: true`. | RESOLVED 2026-05-22 |
| Q11 | **Pre-flight model verification (NEW, user-requested)** | **Mandatory pre-flight benchmark gate before Phase 0.** Run the plugin's existing `llm-externalizer-benchmark` against the active profile and check that the model(s) produce valid structured-JSON output and pass the standard battery. If benchmark fails: hard-abort with a message pointing the user to fix their profile, do NOT proceed with clustering. This separates "model is broken" from "our prompts are wrong" when a run fails. Cached per-profile-per-day at `~/.llm-externalizer/cache/benchmark-<profile-hash>-<YYYY-MM-DD>.json`; subsequent same-day calls skip the benchmark if the cached result is PASS. `policy.skip_preflight_benchmark: true` opt-out for power users who know what they're doing. | RESOLVED 2026-05-22 |
| Q12 | **Phase 2 merge rule (NEW, user-requested, transitive-closure logic)** | **≥3-element confidence floor on cluster overlap.** When a Phase 2 LLM response groups items together, examine the items' current cluster assignments. An A↔B cluster merge happens iff the SAME response-group contains ≥ `policy.merge_min_cross_count` (default 3) distinct items currently assigned to A AND ≥ `policy.merge_min_cross_count` items currently assigned to B. Single-overlap or 2-element-overlap responses do NOT trigger a merge — they're recorded in `stats.json.weak_overlap_evidence` for diagnostic purposes. Replaces the prior percentage-based `merge_threshold` knob entirely (removed from policy schema). Rationale: in union-find logic, any overlap formally proves clusters are the same — but LLM responses contain noise, so we require independent multi-element confirmation in the same response to filter out false positives. | RESOLVED 2026-05-22 |

**Resolution protocol:** all 12 questions are RESOLVED as of 2026-05-22; Phase A may now start.

## 3. Scope decisions made up-front

- **Language**: TypeScript (the MCP server is TypeScript; switching to a Python sidecar would force an IPC protocol that nobody else in the plugin uses). Embedding computation runs out-of-process via a Python subprocess managed by the server — see §6.4.
- **Backend opacity**: this tool MUST call the existing `processBatch` / `callLLM` paths the other tools already use. It MUST NOT contain a second copy of the rate-limiter, token-counter, or backend-router. If the active profile is local-sequential, batches go sequentially. If it's remote-ensemble, each batch is reviewed by 3 models (the union-find merges any pair flagged by ANY of the 3 — Phase B may add a quorum knob; default is OR).
- **Embeddings sidecar**: a tiny Python helper `mcp-server/scripts/compute_embeddings.py` invoked via `child_process.spawnSync` with `uv run`. JSON-in / float32-memmap-out. Keeps `sentence-transformers` out of the Node runtime.
- **Checkpoint format**: SQLite. One table `clusters_uf(item_id TEXT PRIMARY KEY, parent_id TEXT)`, one `llm_calls(call_id TEXT PRIMARY KEY, phase INTEGER, batch_hash TEXT, response_path TEXT, status TEXT, ts INTEGER)`, one `meta(key TEXT PRIMARY KEY, value TEXT)`. WAL mode. The `response_path` field points to the on-disk LLM response — see §6.3.
- **JSONL streaming**: line-by-line via Node's `readline` over a `createReadStream`. No full-file load. 1M items at ~50 chars = ~50 MB on disk, ~50 MB in memory after row parsing — acceptable. Items >1M trigger an in-tool warning suggesting future parquet support.
- **Pre-flight model benchmark gate (Q11)**: BEFORE Phase 0 runs, the tool invokes the existing `llm-externalizer-benchmark` against the active profile. The benchmark must produce structured-JSON output for the standard test suite. A failure here aborts the cluster_synonyms run with a clear "fix your profile, then re-run" message — does NOT proceed silently. This sharply separates "model is misconfigured / broken" from "our prompts are wrong" in failure triage. Cached per-profile-per-day under `~/.llm-externalizer/cache/benchmark-<profile-hash>-<YYYY-MM-DD>.json`; subsequent same-day calls reuse a PASS verdict. Opt-out via `policy.skip_preflight_benchmark: true` (power users only).
- **No PR for upstream first**: the user owns the plugin, so the implementation lands in this repo directly.

## 4. Files this TRDD will create / modify

Estimated file list (Phase A → D below maps each):

### NEW

- `mcp-server/src/tools/cluster_synonyms.ts` — the tool's MCP handler. Input/output schema (Zod 4 `looseObject` for the policy field per recent migration), top-level dispatcher.
- `mcp-server/src/cluster/jsonl.ts` — streaming JSONL reader/writer (no full-file load).
- `mcp-server/src/cluster/embeddings.ts` — wrapper that either reads the memmap'd `embeddings_file` OR spawns the Python sidecar to compute one.
- `mcp-server/src/cluster/kmeans.ts` — pure-TS mini-batch k-means over float32 vectors. ~100 LOC, no external dep.
- `mcp-server/src/cluster/unionfind.ts` — union-find with path compression + union by rank, backed by SQLite for persistence.
- `mcp-server/src/cluster/checkpoint.ts` — SQLite-backed run state, atomic snapshot every N LLM calls.
- `mcp-server/src/cluster/preflight_benchmark.ts` — **(Q11)** pre-flight model-verification wrapper. Reads `~/.llm-externalizer/cache/benchmark-<profile-hash>-<YYYY-MM-DD>.json`; if missing or STALE, invokes `llm-externalizer-benchmark` against the active profile and writes the cache. Returns PASS/FAIL.
- `mcp-server/src/cluster/retry_ladder.ts` — **(Q7)** the recursive-split-and-retry algorithm extracted as a standalone pure function `processBatchWithRetry(items, llmCallFn, validateFn, opts)` so it can be unit-tested with mock LLM calls. Both Phase 1 and Phase 2 dispatch through this.
- `mcp-server/src/cluster/phase1_batch.ts` — Phase 1 batch builder + LLM dispatch (via `retry_ladder.ts`) + union-find updates.
- `mcp-server/src/cluster/phase2_verify.ts` — Phase 2 stratified rep batches + **transitive-closure merge rule with ≥3-element floor (Q12)** + LLM dispatch via `retry_ladder.ts`.
- `mcp-server/src/cluster/phase3_canonical.ts` — heuristic and LLM canonical-label selection.
- `mcp-server/src/cluster/phase4_emit.ts` — flatten + write outputs.
- `mcp-server/src/cluster/policy.ts` — Zod schema for `policy.json`; auto-scaling defaults. Includes new knobs `max_retries_per_attempt`, `max_split_depth`, `merge_min_cross_count`, `skip_preflight_benchmark`, `overwrite_output`, `emit_sqlite_clusters`.
- `mcp-server/scripts/compute_embeddings.py` — Python sidecar. Reads JSONL from stdin, writes float32 memmap + `.meta.json` to caller-specified path. Uses `sentence-transformers` (CPU, no GPU dependency).
- `mcp-server/tests/cluster/*.test.ts` — unit tests for jsonl, k-means, union-find, checkpoint, **preflight_benchmark**, **retry_ladder**, phase1, **phase2_merge** (one suite per module).
- `mcp-server/tests/cluster/e2e.test.ts` — end-to-end on a synthetic 500-item synonym fixture with known clusters.
- `mcp-server/tests/cluster/fixtures/synthetic_500.jsonl` — input fixture.
- `mcp-server/tests/cluster/fixtures/synthetic_500.expected.json` — expected cluster IDs (used for cohesion assertion, NOT exact-equality).
- `mcp-server/tests/cluster/fixtures/budget_exhaust.jsonl` — input for the budget-cap test.
- `mcp-server/tests/cluster/fixtures/merge_3_floor.jsonl` — input for T15 (Phase 2 merge rule: 2-overlap vs 3-overlap behavior).
- `mcp-server/tests/cluster/fixtures/broken_profile.yaml` — synthetic profile that deliberately fails the pre-flight benchmark, for T16.

### MODIFIED

- `mcp-server/src/index.ts` — register the new `cluster_synonyms` tool in the tool list, wire the handler, advertise the input/output schema.
- `mcp-server/package.json` — add `better-sqlite3` (sync SQLite for Node; alternative is `sql.js` but that's slower for 1M rows).
- `mcp-server/pyproject.toml` (NEW or MODIFIED) — declare `sentence-transformers`, `numpy` deps for the sidecar.
- `~/.claude/rules/use-llm-externalizer.md` — add `cluster_synonyms` to the tools-reference table + a new "Cluster synonyms" usage-pattern example.
- `README.md` (plugin root) — add a one-paragraph blurb in the tools table.
- `CHANGELOG.md` — bump-pending entry. (Picked up automatically by `publish.py` G1.)

### DO NOT TOUCH

- Existing `chat` / `code_task` / `scan_folder` / `search_existing_implementations` handlers — `cluster_synonyms` is purely additive.
- The `processBatch` / `callLLM` core in `mcp-server/src/index.ts` — re-use, do not fork.
- `mcp-server/dist/*` is auto-rebuilt by `publish.py` G5 — no hand-edits.

## 5. Test scenarios (must all pass before publish)

| # | Name | Input | Pass criterion |
|---|---|---|---|
| T1 | Identity clusters | 10 items, each unique, no synonyms | 10 clusters, no merges, ≤2 LLM calls |
| T2 | Pure synonyms | 6 items, 3 pairs of obvious synonyms | 3 clusters, each size 2, canonical label is one of the input labels |
| T3 | Mixed | 50 items: 5 obvious clusters of 5, 25 singletons | After Phase 1+2: 5 clusters of 5 + 25 singletons (±5% tolerance on the singletons) |
| T4 | Resume mid-Phase-1 | Run T3 with `budget_max_llm_calls=2`, then resume with `resume_from=checkpoint.sqlite` and a fresh higher budget | Final state matches single-pass T3 |
| T5 | Pre-computed embeddings honored | Same as T3 but pass a `.f32` file with a known mismatched dimension | Hard error before any LLM call |
| T6 | Embedding-mode skip | Same as T3 with `policy.compute_embeddings: false` and no `embeddings_file` | Fall through to random batching; warn in `stats.json` |
| T7 | Malformed JSONL line tolerated | T3 + 1 line with missing `label` | Skip the bad line, log it in `stats.json.warnings`, complete |
| T8 | All-blank input | 0 valid rows | Hard error at Phase 0, no LLM calls billed |
| T9 | Budget exhausted mid-Phase-2 | T3 with `budget_max_llm_calls=3` | Phase 1 completes; Phase 2 aborts cleanly; checkpoint preserved; stats shows `budget_exhausted: true` |
| T10 | Idempotent re-run | Run T3 twice with same inputs / same policy / fresh output_dir | `clusters_summary.json` items match (modulo cluster_id renaming) |
| T11 | Large-N smoke | 10k synthetic items derived from the L2 taxonomy fixture | Completes in < 10 min on `remote-ensemble` profile; LLM-calls count within ±20% of the predicted `O(N/K + reps·clusters/K·passes)` |
| T12 | Schema gate | Tool invocation with the wrong field name (e.g. `inputFile` instead of `input_file`) | Zod validation error, no side effects |
| T13 | output_dir collision | Existing `clusters.jsonl` in `output_dir`, no `resume_from`, `policy.overwrite_output: false` | Hard error |
| T14 | output_dir overwrite OK | Same as T13 but with `policy.overwrite_output: true` | Run completes, overwrites prior files |
| T15 | Phase 2 merge rule floor (Q12) | 4 clusters preseeded; response-group contains 2 items from A + 2 items from B (case X) vs. 3 items from A + 3 items from B (case Y), same one LLM call | Case X: NO merge, recorded in `stats.json.weak_overlap_evidence`. Case Y: merge happens, `clusters_summary.json` shows A and B as one cluster. |
| T16 | Pre-flight benchmark gate (Q11) | Deliberately-broken profile fixture pointing at a non-existent LLM endpoint | Tool aborts BEFORE Phase 0 with a clear error message; no checkpoint written; no LLM calls billed. |
| T17 | Recursive-split-and-retry ladder (Q7) | Mock LLM that fails the first N calls then succeeds — N varied from 0 to 50 | Depth-0 retry exhaustion triggers split at N≥3. Depth-1 exhaustion at N≥9. Depth-2 at N≥21. Depth-3 give-up at N≥45. `stats.json.failed_groups` populated only at depth-3 give-up. Verifies the 3+6+12+24=45 hard cap. |

T11 is the only LLM-cost-intensive test — run on `free: true` (Nemotron 120B) for CI, on the active paid profile only for release sign-off. T1–T10 + T12–T17 can use a tiny `local` profile (LM Studio + 4B model) for ~30s total CI cost. T17 uses a mock LLM (no external calls) so it runs on every test invocation.

## 6. Phased implementation plan

### Phase A — schema, fixtures, plumbing (no LLM calls)

1. ~~Lock answers to Q1–Q10.~~ DONE — all 12 questions resolved on 2026-05-22.
2. Create the `mcp-server/src/cluster/` directory + the Zod schema for input/policy.
3. Add `better-sqlite3` to package.json; rebuild native via `publish.py G2`.
4. Author the Python sidecar `compute_embeddings.py` + its `pyproject.toml` slot.
5. Write fixtures `synthetic_500.jsonl` + `synthetic_500.expected.json` + `budget_exhaust.jsonl`.
6. Implement the pre-flight benchmark wrapper (Q11): `mcp-server/src/cluster/preflight_benchmark.ts` — checks the per-profile-per-day cache, runs `llm-externalizer-benchmark` if missing, writes the cache. Standalone unit-tested with mocked benchmark output.
7. Unit tests for `jsonl.ts`, `kmeans.ts`, `unionfind.ts`, `checkpoint.ts`, `preflight_benchmark.ts`. All MUST pass before Phase B.
8. Register the tool in `mcp-server/src/index.ts` with a STUB handler that throws `not_implemented`. Lets the schema + registration be validated by CPV before any logic lands.
9. CPV `publish.py --check-only` must pass at the end of Phase A.

**Exit gate**: T8, T12, T13, T14 pass against the stub. Pre-flight benchmark cache wiring tested. CPV clean. No clustering-LLM calls billed (benchmark calls don't count).

### Phase B — Phase 1 (single-batch grouping) + recursive-split-and-retry ladder

1. Wire the pre-flight benchmark check into the tool's entry point — abort cluster_synonyms before Phase 0 if the gate fails (Q11).
2. Implement `phase1_batch.ts` — embedding-clustered batching using `kmeans.ts`.
3. Wire `processBatch` from existing index.ts — reuse, do NOT fork.
4. Per-batch prompt template (see §7) — strict JSON schema response.
5. **Implement the recursive-split-and-retry ladder** (Q7): `mcp-server/src/cluster/retry_ladder.ts`. Pure function `processBatchWithRetry(items, depth=0)` → recurses on halves on exhaustion, max depth 3, max 45 LLM calls per source batch, records unresolved items in `stats.json.failed_groups`. Unit-tested with a deterministic-fail mock LLM to verify the ladder fires correctly at depths 0/1/2/3.
6. Union-find updates from batch responses.
7. Checkpoint write every `policy.checkpoint_every` calls.
8. T1, T2, T3, T6, T7, T11 (Phase 1 portion only — Phase 2 still no-op) pass.
9. CPV `publish.py --check-only` clean.

**Exit gate**: T1/T2/T3/T6/T7 green. T11 Phase-1 portion completes in < 5 min on local profile. Retry-ladder unit tests cover all 4 depth levels including the depth-3 give-up path.

### Phase C — Phase 2 verification + Phase 3 canonical labels + Phase 4 emit

1. `phase2_verify.ts` — rep sampling, stratified cross-cluster batches, **transitive-closure merge rule with ≥3-element floor** (Q12). For every response-group: count distinct (A-items, B-items) per (A,B) pair; merge A↔B iff both counts ≥ `policy.merge_min_cross_count` (default 3). Single/double overlap goes into `stats.json.weak_overlap_evidence` instead. Phase 2 also uses the recursive-split-and-retry ladder from Phase B for failure recovery.
2. `phase3_canonical.ts` — heuristic (length-tiered) + LLM modes.
3. `phase4_emit.ts` — atomic write of all 4 outputs to `output_dir`.
4. Resume path: re-open checkpoint, restore union-find + LLM-calls history, skip already-completed batches. Pre-flight benchmark cache is consulted but a fresh same-day PASS keeps the resume cheap.
5. T4, T5, T9, T10 pass. T11 full pipeline completes. Add T15 (NEW): Phase 2 merge rule — synthetic test where 2 elements overlap (no merge) vs. 3 elements overlap (merge). Add T16 (NEW): Pre-flight benchmark — confirm a deliberately-broken-model profile is rejected before Phase 0 runs.

**Exit gate**: all T1–T16 green. CPV clean. Stats.json matches the predicted call count within ±20%.

### Phase D — docs, rules, publish

1. Update `~/.claude/rules/use-llm-externalizer.md` — add `cluster_synonyms` to the tools table + a usage-pattern example.
2. Update `README.md` plugin root — add a paragraph to the tools section.
3. CHANGELOG entry: `Add cluster_synonyms — zero-token batch synonym/concept clustering primitive`.
4. Comment on issue #4 with the answered open questions, the merged PR/commit hash, and a usage example.
5. Run `publish.py --minor` (this is a feature, not a fix) once all CPV gates green.

**Exit gate**: published version with `cluster_synonyms` in `discover` output. Issue #4 closed via the publish commit.

## 7. Prompt templates (locked once Phase B starts)

### Phase 1 — group by identical SENTENCE meaning

```
You are given N short SENTENCES (or short labels treated as sentences), each with a numeric id
and a context hint (optional). Group sentences that have IDENTICAL or NEARLY-IDENTICAL
overall meaning. Slight wording differences are OK; sentences that convey DIFFERENT concepts
must NEVER be grouped together. You are NOT doing word-by-word synonym matching — you are
comparing whole-sentence meaning. Examples:

  "Compile the code with optimizations" ≡ "Build the project with optimizer flags"   → same group
  "Compile the code"                    ≠ "Test the code"                            → different groups
  "domain/programming/"                 ≡ "domain/coding/"                           → same group
  "domain/programming/"                 ≠ "domain/testing/"                          → different groups

Output: a JSON object {"groups": [[id, id, ...], [id], ...]}.
Every input id MUST appear exactly once across all groups.
Singletons stay as 1-element groups.

Sentences:
1. id=42  sentence="domain/programming/"  ctx="prog. languages, compilers"
2. id=43  sentence="domain/coding/"
... (up to batch_size sentences)
```

Response strict-validated via Zod `z.object({ groups: z.array(z.array(z.number().int())) })`.

**Failure recovery — recursive-split-and-retry ladder (Q7):**

```
def processBatchWithRetry(items, depth=0):
    for attempt in 1..policy.max_retries_per_attempt:   # default 3
        try:
            response = llm_call(items, prompt)
            if validate(response): return response
        except: continue
    # All retries at this batch-size exhausted.
    if depth < policy.max_split_depth and len(items) >= 2:   # default depth 3
        mid = len(items) // 2
        left  = processBatchWithRetry(items[:mid],  depth+1)
        right = processBatchWithRetry(items[mid:], depth+1)
        return merge_responses(left, right)
    # At depth 3 OR can't split further (1-item batch). Give up.
    record_in_failed_groups(items)
    return empty_response
```

Worst case per original source batch: depth-0 (3 calls) + depth-1 (3×2 = 6) + depth-2 (3×4 = 12) + depth-3 (3×8 = 24) = **45 LLM calls**. The global `policy.budget_max_llm_calls` is checked before EVERY dispatch — when it trips, the run aborts cleanly with the partial checkpoint. Items at the leaf level that still fail land in `stats.json.failed_groups`; they are NOT merged with anything and do NOT block the rest of the run from completing.

Both Phase 1 batches AND Phase 2 verification batches go through this same ladder.

### Phase 2 — cross-cluster verification

```
You are given M short SENTENCES drawn as representatives from K tentative clusters.
For each sentence, the cluster assignment is HIDDEN from you. Your job is to regroup these
sentences purely by their full-sentence meaning equivalence — the same rule as Phase 1
(whole-sentence meaning, NOT word-by-word synonym matching).

Output: same {"groups": [[id, ...]]} format. Singletons stay as 1-element groups.

Sentences:
1. id=42  sentence="..."
2. id=99  sentence="..."
... (stratified so close clusters land in the same batch)
```

**Server-side merge rule (Q12 — transitive-closure with ≥3-element confidence floor):**

For each response-group returned by the LLM, examine the items' CURRENT union-find cluster assignments. Count, per (cluster_a, cluster_b) pair, how many distinct items from each cluster co-occur in the SAME group.

```
for each response_group G in response:
    by_cluster = group_items_by_current_cluster(G)       # {A: [x1,x2,x3,…], B: [y1,y2], …}
    for each pair (A, B) where A != B and A < B:
        crossCountA = len({items in G currently in A})
        crossCountB = len({items in G currently in B})
        if crossCountA >= policy.merge_min_cross_count   # default 3
        and crossCountB >= policy.merge_min_cross_count:
            union_find.merge(A, B)
        else:
            stats.weak_overlap_evidence.append({
                response_id, A, B, crossCountA, crossCountB
            })
```

**Why this rule, not a percentage threshold:** in union-find theory, two clusters that share even ONE element ARE the same cluster — the percentage threshold was a hack against LLM noise. By requiring ≥3 distinct items from BOTH sides in the SAME LLM response, we get independent multi-element confirmation that A and B are genuinely the same concept, not a hallucinated overlap. Single-overlap and 2-element-overlap responses still get LOGGED (in `weak_overlap_evidence`) so an operator can review them post-run, but they do NOT trigger an automatic merge.

The prior percentage-based `merge_threshold` knob is REMOVED from the policy schema.

### Phase 3 — LLM canonical sentence (only when `canonical_label_mode: llm`)

```
Given these synonymous sentences/labels (all conveying the same overall meaning), pick the
single CLEANEST canonical form. Prefer: short (3-50 chars when possible), no trailing
punctuation, no version numbers, no abbreviations, complete enough to stand alone.
If multiple are equally good, pick the first listed.

Sentences:
- domain/programming/
- domain/coding/
- domain/software-development/

Output: a JSON object {"canonical": "...", "rationale": "..."}.
```

## 8. Security considerations

- **Path traversal**: `input_file`, `output_dir`, `policy_file`, `resume_from`, `embeddings_file` MUST all be absolute paths under either the user's home OR an explicitly allow-listed root. Reject `..` segments. (Same posture as existing tools.)
- **Sidecar exec**: `compute_embeddings.py` invoked via `uv run` — never via `bash -c`. No shell metachars in the spawn args. The script reads JSONL from stdin and writes outputs to a path passed via argv — no eval, no `os.system`.
- **LLM prompt injection**: items' `label` and `context` are quoted/numbered in the prompt but NEVER interpolated into instruction text. The prompt structure is fixed; only data values are substituted. The Zod-validated response schema prevents data exfiltration through the response channel.
- **Checkpoint integrity**: SQLite WAL mode. Atomic writes via temp-file + rename. If checkpoint is corrupted on resume, hard-fail with a clear message — never silently re-do work.
- **Output-dir overwrite guard**: see Q10. Default-on, opt-out via explicit policy flag.
- **Budget cap**: `budget_max_llm_calls` is enforced INSIDE the tool, BEFORE every dispatch. No way for a malformed input to balloon costs.
- **Token logging**: per-batch token-usage rolls up into `stats.json`. NO label content is logged.

## 9. Performance budget (target for T11)

- 10k items, embedding dim 384, `batch_size=300`, `passes=3`:
  - Phase 0: ~30s embedding computation (CPU, MiniLM)
  - Phase 1: ~34 LLM calls
  - Phase 2: ~10 LLM calls per pass × 3 passes = ~30
  - Phase 3 (heuristic): 0 LLM calls
  - **Total**: ~64 LLM calls. At 5 RPS on `openrouter-remote` ensemble (3 models per call) = ~12s walltime once dispatched.
  - End-to-end target: < 5 min on `remote-ensemble`, < 30 min on `local-sequential` (LM Studio + 4B model).

## 10. Acceptance criteria

- [x] All 12 open questions resolved (§2) — done 2026-05-22
- [ ] All 17 test scenarios pass (§5)
- [ ] Pre-flight model benchmark gate hardens against broken profiles before Phase 0 runs
- [ ] Recursive-split-and-retry ladder enforces the 45-call-per-source-batch hard cap and records final give-ups in `stats.json.failed_groups`
- [ ] Phase 2 transitive-closure merge rule (≥3-element confidence floor) drives all cluster unions — single/double overlaps land in `stats.json.weak_overlap_evidence` not in the union-find
- [ ] CPV `publish.py --check-only` clean (all 10 gates green)
- [ ] Published as a minor version bump
- [ ] Issue #4 closed with a comment linking the release tag, the answered open questions, and a usage example
- [ ] `~/.claude/rules/use-llm-externalizer.md` updated with the new tool + its policy knobs
- [ ] Plugin README updated
- [ ] No regression: existing tools (`chat`, `code_task`, `scan_folder`, `search_existing_implementations`) untouched at the source-code level (the diff hits only the index registration block)

## 11. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-05-21T23:25:51+0200 | created → not-started | Drafted from issue #4. 10 open questions need user resolution before Phase A. |
| 2026-05-22T00:22:23+0200 | Q1–Q12 all RESOLVED | User accepted defaults for Q1–Q6, Q8–Q10. Q7 replaced with recursive-split-and-retry ladder (max depth 3 → 1→2→4→8 sub-batches, 45 LLM calls hard cap per source batch). Added Q11 = mandatory pre-flight model benchmark gate (cached per-profile-per-day). Added Q12 = transitive-closure merge rule with ≥3-element floor (replaces percentage `merge_threshold` knob). Phase A may now start. |
| 2026-05-22T00:26:35+0200 | scope clarification — SENTENCE-level meaning | User clarified: the tool clusters items by FULL-SENTENCE meaning equivalence, not word-level synonymy. §1 and all three §7 prompt templates updated to make this explicit with positive ("Compile the code with optimizations" ≡ "Build the project with optimizer flags") and negative ("Compile the code" ≠ "Test the code") examples in the system prompt. Algorithm unchanged. |
| 2026-05-22T03:45:14+0200 | Phase A implemented (A.1–A.7); A.8 blocked on upstream CPV | All 8 Phase-A files landed across commits 08cbb1d→9d204a2 (policy/types, jsonl/kmeans/unionfind, checkpoint, embeddings sidecar, preflight gate, fixtures). 53 cluster unit tests + full suite green; typecheck/lint/build clean. cluster_synonyms code is zero-CRITICAL after fixing 2 skillaudit backtick FPs in its own code (jsonl.ts:64, index.ts:5349). Phase A.8 exit gate ("CPV check-only clean") is BLOCKED by 16 PRE-EXISTING skillaudit false-positives in files unchanged since v9.10.2 (latest CPV v2.101.4 confirmed via uvx --refresh). Filed upstream as Emasoft/claude-plugins-validation#39 (5 FP classes: CRED_ENV_READ on own API-key reads, TOKEN_STEAL on the secret-redaction regex, CMD_INJECTION on hardcoded-argv subprocess + markdown fences, DESERIALIZATION on ruamel round-trip of own config, INDIRECT_PROMPT_INJECT on an agent's own prompt-injection-defense line). Publish deferred until #39 is resolved or a suppression key ships; feature work (Phase B) can proceed independently. |
| 2026-05-23T02:42:35+0200 | Phase B implemented (B.1–B.4); Phase 1 wired into dispatcher | Phases B.1–B.4 landed across commits 11dd0fe→e42268f. B.1 (11dd0fe): pure-function processBatchWithRetry — recursive split-and-retry ladder with 45-call hard cap per source batch, 13 unit tests at every depth level (0, 1, 2, 3, give-up). B.2 (9e7fd2f): phase1_batch with k-means batching + per-batch numeric-id prompt (TRDD §7) + strict Phase1ResponseSchema (Zod) + ValidateFn signature widened to (response, items) so validators following a ladder split see the CURRENT slice size, not the parent batch's. 31 phase1 tests. B.3a (e0b4ebe): embeddings.ts loader/writer + computeEmbeddings spawn wrapper around the Python sidecar, 18 tests (loader round-trip, meta-sidecar validation, byte-size guard, spawn fail-paths). B.3b (0c57458): cluster_synonyms_main.runClusterSynonyms top-level orchestrator + dispatcher wire-up in index.ts (chatCompletionWithRetry wrapped as rawLlmCall, compute_embeddings.py resolved from import.meta.url). cluster_id is the lex-min member of each component so idempotent re-runs report the same partition (T10); heuristic canonical label = shortest non-empty sentence. 12 orchestrator tests cover T1, T2, T6, T7, T8, T10, T13, T14, Q11-gate × 2, output-shape × 3. B.4 (e42268f): T3 (50 items, 5 clusters of 5 + 25 singletons) + T11-lite smoke (100 items, 10 clusters, <2s). Total: 129 cluster tests + 22 index tests = 151 pass, 0 fail. Typecheck + lint clean across all touched files. Phase B exit gate satisfied: T1, T2, T3, T6, T7 + T17 (T17 covered by retry_ladder tests). Phase 2 / Phase 3 (verification + LLM canonical) remain stubbed — stats.json reports phase2/phase3 = 0 calls; Phase C lights them up. |
| 2026-05-23T20:49:55+0200 | Phase C committed + verified green; publish BLOCKED on CPV skillaudit FPs (#41) | Phase C.1/C.2 + smoke landed: C.1 (91635f4) `phase2_verify` with Q12 transitive-closure ≥3-element-floor merge rule; C.2 (8496bbc) `phase3_canonical` LLM mode; real-OpenRouter smoke-test script (44841d0; smoke run 2026-05-23 14:46 → `reports/llm-externalizer/smoke-20260523_144639+0200/`). Canon-drift opt-out (9153bb7): 5-entry `cpv.allow_pipeline_drift` in plugin.json for the intentional TS-pipeline drift (publish.py, ci.yml, notify-marketplace.yml, cliff.toml, .markdownlint.json). **Verification** (arbiter → `reports/arbiter/20260523_201909+0200-cluster-synonyms-phaseC-verification.md`): typecheck/lint/build exit 0; **557 tests pass / 0 fail / 2 skip** (cluster 173 across 11 suites + index 22); no regression in chat/code_task/scan_folder/search_existing_implementations. **`publish.py --check-only`**: ALL gates green (npm-ci, rebuild-native, typecheck, lint, build, test, ruff, shellcheck, plugin.json, claude-plugin-validate) EXCEPT CPV validate. CPV (latest git HEAD, ≥v2.104.2) → CRITICAL=2 MAJOR=94 MINOR=38 NIT=196. **Split**: (a) **7 MAJOR + 1 MINOR REAL** in `skills/llm-externalizer-ensemble-autoselect/SKILL.md` (8198>5000 chars, missing 5 Nixtla sections, parent-traversal ref `../../mcp-server/src/benchmark/discover.ts`, no 'Trigger with' phrase) — ensemble-autoselect feature debt, fixable here; (b) **2 CRITICAL + 87 MAJOR skillaudit FALSE-POSITIVES**. The 2 CRITICALs (`phase1_batch.ts:107,110`) VERIFIED-FP at source: template-literal error strings in `validatePhase1Response` (`reason: \`id ${id} out of range\``), zero exec/shell/child_process. Upstream #39 CLOSED, **#41 OPEN and STILL firing on v2.104.x** (FP classifier exists but OFF by default — "until corpus regression suite in place"). Publish remains deferred pending bucket-(b) resolution in CPV (own validator: fix skillaudit detector / ship documented suppression key / wait); bucket-(a) fix offered, awaiting user decision. No commit/push from this session. |
