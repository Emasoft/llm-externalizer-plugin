---
trdd-id: 220ea89f-0af2-4eba-884d-367a986d27e7
title: cluster_synonyms — zero-token batch synonym clustering MCP primitive
status: not-started
created: 2026-05-21T23:25:51+0200
updated: 2026-05-21T23:25:51+0200
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

## 2. Open questions (must resolve BEFORE Phase A starts)

These are the issue's open questions plus implementation-required additions:

| Q | Question | Default proposal | Resolution status |
|---|---|---|---|
| Q1 | Tool name: `cluster_synonyms`, `group_by_meaning`, `dedup_concepts`, other? | `cluster_synonyms` (matches issue title; "synonyms" implies the IDENTICAL-meaning bar that Phase 2 enforces) | OPEN |
| Q2 | Embedding computation: in-tool default vs. caller-only? | In-tool default ON via `sentence-transformers/all-MiniLM-L6-v2` (lightweight, no GPU). Caller can pass `embeddings_file` to skip. | OPEN |
| Q3 | SQLite output: default emit vs. opt-in? | Default emit — checkpoint already needs sqlite, the extra cost is negligible. Add `policy.emit_sqlite_clusters: bool` knob (default true). | OPEN |
| Q4 | Default `canonical_label_mode`: `heuristic` or `llm`? | `heuristic` (no extra LLM cost; cluster size is small enough that the user can re-run with `llm` if quality is insufficient) | OPEN |
| Q5 | Bake `sentence-transformers` as a default dep? | Yes — opt-out via `policy.compute_embeddings: false`. ST is the de-facto default in the Python embedding world; alternative is `fastembed` (ONNX, no torch) — keep as a phase-B knob. | OPEN |
| Q6 | Concurrency model for batch LLM calls (NEW) | Inherit the profile's existing concurrency (local = sequential, remote = up-to-200-in-flight). No new in-tool semaphore. | OPEN |
| Q7 | Failure semantics inside a batch (NEW) | Per-batch retry up to `policy.max_retries_per_batch` (default 2). After exhaustion: log the batch as "unresolved", do NOT block the run, do NOT merge any pairs from the failed batch. Surface the count in `stats.json`. | OPEN |
| Q8 | Input-format validation strictness (NEW) | Reject the whole run if `input_file` has zero valid rows or `id` collisions. Skip individual malformed lines with a warning entry in `stats.json`. | OPEN |
| Q9 | Embedding model dimension drift (NEW) — what if the `.meta.json` model name does not match `policy.embedding_model`? | Hard error. The caller must pass a matching meta.json or omit `embeddings_file` so the tool recomputes. | OPEN |
| Q10 | Output_dir conflict (NEW) — what if it already has `clusters.jsonl`? | If `resume_from` is set, allow it (we're continuing). Otherwise hard error unless `policy.overwrite_output: true`. | OPEN |

**Resolution protocol:** answer all 10 in the issue thread or in this TRDD (replace OPEN with a one-line decision + date) before Phase A starts. Do NOT start coding while any question is OPEN — the tool's public schema depends on them.

## 3. Scope decisions made up-front

- **Language**: TypeScript (the MCP server is TypeScript; switching to a Python sidecar would force an IPC protocol that nobody else in the plugin uses). Embedding computation runs out-of-process via a Python subprocess managed by the server — see §6.4.
- **Backend opacity**: this tool MUST call the existing `processBatch` / `callLLM` paths the other tools already use. It MUST NOT contain a second copy of the rate-limiter, token-counter, or backend-router. If the active profile is local-sequential, batches go sequentially. If it's remote-ensemble, each batch is reviewed by 3 models (the union-find merges any pair flagged by ANY of the 3 — Phase B may add a quorum knob; default is OR).
- **Embeddings sidecar**: a tiny Python helper `mcp-server/scripts/compute_embeddings.py` invoked via `child_process.spawnSync` with `uv run`. JSON-in / float32-memmap-out. Keeps `sentence-transformers` out of the Node runtime.
- **Checkpoint format**: SQLite. One table `clusters_uf(item_id TEXT PRIMARY KEY, parent_id TEXT)`, one `llm_calls(call_id TEXT PRIMARY KEY, phase INTEGER, batch_hash TEXT, response_path TEXT, status TEXT, ts INTEGER)`, one `meta(key TEXT PRIMARY KEY, value TEXT)`. WAL mode. The `response_path` field points to the on-disk LLM response — see §6.3.
- **JSONL streaming**: line-by-line via Node's `readline` over a `createReadStream`. No full-file load. 1M items at ~50 chars = ~50 MB on disk, ~50 MB in memory after row parsing — acceptable. Items >1M trigger an in-tool warning suggesting future parquet support.
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
- `mcp-server/src/cluster/phase1_batch.ts` — Phase 1 batch builder + LLM dispatch + union-find updates.
- `mcp-server/src/cluster/phase2_verify.ts` — Phase 2 stratified rep batches + merge-or-not decision.
- `mcp-server/src/cluster/phase3_canonical.ts` — heuristic and LLM canonical-label selection.
- `mcp-server/src/cluster/phase4_emit.ts` — flatten + write outputs.
- `mcp-server/src/cluster/policy.ts` — Zod schema for `policy.json`; auto-scaling defaults.
- `mcp-server/scripts/compute_embeddings.py` — Python sidecar. Reads JSONL from stdin, writes float32 memmap + `.meta.json` to caller-specified path. Uses `sentence-transformers` (CPU, no GPU dependency).
- `mcp-server/tests/cluster/*.test.ts` — unit tests for k-means, union-find, jsonl, phase1, phase2, phase3 (one suite per module).
- `mcp-server/tests/cluster/e2e.test.ts` — end-to-end on a synthetic 500-item synonym fixture with known clusters.
- `mcp-server/tests/cluster/fixtures/synthetic_500.jsonl` — input fixture.
- `mcp-server/tests/cluster/fixtures/synthetic_500.expected.json` — expected cluster IDs (used for cohesion assertion, NOT exact-equality).
- `mcp-server/tests/cluster/fixtures/budget_exhaust.jsonl` — input for the budget-cap test.

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

T11 is the only LLM-cost-intensive test — run on `free: true` (Nemotron 120B) for CI, on the active paid profile only for release sign-off. T1–T10 + T12–T14 can use a tiny `local` profile (LM Studio + 4B model) for ~30s total CI cost.

## 6. Phased implementation plan

### Phase A — schema, fixtures, plumbing (no LLM calls)

1. Lock answers to Q1–Q10. Update §2 with decisions.
2. Create the `mcp-server/src/cluster/` directory + the Zod schema for input/policy.
3. Add `better-sqlite3` to package.json; rebuild native via `publish.py G2`.
4. Author the Python sidecar `compute_embeddings.py` + its `pyproject.toml` slot.
5. Write fixtures `synthetic_500.jsonl` + `synthetic_500.expected.json` + `budget_exhaust.jsonl`.
6. Unit tests for `jsonl.ts`, `kmeans.ts`, `unionfind.ts`, `checkpoint.ts`. All MUST pass before Phase B.
7. Register the tool in `mcp-server/src/index.ts` with a STUB handler that throws `not_implemented`. Lets the schema + registration be validated by CPV before any logic lands.
8. CPV `publish.py --check-only` must pass at the end of Phase A.

**Exit gate**: T8, T12, T13, T14 pass against the stub. CPV clean. No LLM calls billed.

### Phase B — Phase 1 (single-batch grouping)

1. Implement `phase1_batch.ts` — embedding-clustered batching using `kmeans.ts`.
2. Wire `processBatch` from existing index.ts — reuse, do NOT fork.
3. Per-batch prompt template (see §7) — strict JSON schema response.
4. Union-find updates from batch responses.
5. Checkpoint write every `policy.checkpoint_every` calls.
6. T1, T2, T3, T6, T7, T11 (Phase 1 portion only — Phase 2 still no-op) pass.
7. CPV `publish.py --check-only` clean.

**Exit gate**: T1/T2/T3/T6/T7 green. T11 Phase-1 portion completes in < 5 min on local profile.

### Phase C — Phase 2 verification + Phase 3 canonical labels + Phase 4 emit

1. `phase2_verify.ts` — rep sampling, stratified cross-cluster batches, merge-or-not logic.
2. `phase3_canonical.ts` — heuristic (length-tiered) + LLM modes.
3. `phase4_emit.ts` — atomic write of all 4 outputs to `output_dir`.
4. Resume path: re-open checkpoint, restore union-find + LLM-calls history, skip already-completed batches.
5. T4, T5, T9, T10 pass. T11 full pipeline completes.

**Exit gate**: all T1–T14 green. CPV clean. Stats.json matches the predicted call count within ±20%.

### Phase D — docs, rules, publish

1. Update `~/.claude/rules/use-llm-externalizer.md` — add `cluster_synonyms` to the tools table + a usage-pattern example.
2. Update `README.md` plugin root — add a paragraph to the tools section.
3. CHANGELOG entry: `Add cluster_synonyms — zero-token batch synonym/concept clustering primitive`.
4. Comment on issue #4 with the answered open questions, the merged PR/commit hash, and a usage example.
5. Run `publish.py --minor` (this is a feature, not a fix) once all CPV gates green.

**Exit gate**: published version with `cluster_synonyms` in `discover` output. Issue #4 closed via the publish commit.

## 7. Prompt templates (locked once Phase B starts)

### Phase 1 — group by identical meaning

```
You are given N items, each with a numeric id and a short label (optionally a context hint).
Group items that have IDENTICAL or NEARLY-IDENTICAL meaning. Slight wording differences are OK;
two items that refer to DIFFERENT concepts must NEVER be grouped.

Output: a JSON object {"groups": [[id, id, ...], [id], ...]}.
Every input id MUST appear exactly once across all groups.
Singletons stay as 1-element groups.

Items:
1. id=42  label="domain/programming/"  ctx="prog. languages, compilers"
2. id=43  label="domain/coding/"
... (up to batch_size items)
```

Response strict-validated via Zod `z.object({ groups: z.array(z.array(z.number().int())) })`. On parse failure: retry once with a "reply with VALID JSON only" suffix. On second failure: mark batch unresolved.

### Phase 2 — cross-cluster verification

```
You are given M items drawn as representatives from K tentative clusters.
For each item, the cluster_id is hidden — your job is to regroup them by meaning ONLY.

Output: same {"groups": [[id, ...]]} format.

Items:
1. id=42 (from cluster A)  label="..."
2. id=99 (from cluster B)  label="..."
... (stratified so close clusters land in the same batch)
```

Server-side merge rule: if ≥ `policy.merge_threshold` (default 0.6) of cluster A's representatives end up in the same response-group as ≥ `policy.merge_threshold` of cluster B's representatives, union A and B in the union-find.

### Phase 3 — LLM canonical label (only when `canonical_label_mode: llm`)

```
Given these synonymous labels for one concept, pick the single CLEANEST canonical form.
Prefer: short (3-50 chars), no trailing punctuation, no version numbers, no abbreviations.
If multiple are equally good, pick the first listed.

Labels:
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

- [ ] All 10 open questions resolved (§2)
- [ ] All 14 test scenarios pass (§5)
- [ ] CPV `publish.py --check-only` clean (all 10 gates green)
- [ ] Published as a minor version bump
- [ ] Issue #4 closed with a comment linking the release tag
- [ ] `~/.claude/rules/use-llm-externalizer.md` updated
- [ ] Plugin README updated
- [ ] No regression: existing tools (`chat`, `code_task`, `scan_folder`, `search_existing_implementations`) untouched at the source-code level (the diff hits only the index registration block)

## 11. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-05-21T23:25:51+0200 | created → not-started | Drafted from issue #4. 10 open questions need user resolution before Phase A. |
