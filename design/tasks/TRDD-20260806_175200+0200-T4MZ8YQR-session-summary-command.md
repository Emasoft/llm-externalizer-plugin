---
trdd-id: T4MZ8YQR
title: New command — compaction-style summary of a Claude Code session from its JSONL transcript
column: todo
created: 2026-08-06T17:52:00+0200
updated: 2026-08-06T17:52:00+0200
current-owner: claude-llm-externalizer
assignee: null
priority: 2
severity: MEDIUM
effort: L
labels: [cli, free-mode, transcripts, summarization]
task-type: feature
parent-trdd: null
npt: []
eht: []
blocked-by: []
relevant-rules: []
release-via: publish
delivery: direct-push
target-branch: main
test-requirements: [unit, typecheck, lint]
review-requirements: [human-review]
runtime-targets: [macos, linux]
impacts: [public-api]
implementation-commits: []
---

# `llm-ext session-summary` — compaction-style summary of a whole session

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-06

**User request (2026-08-06):** a new command that generates a summary (compaction-like) of the
whole session from the JSONL transcript of the project session, **using only free models with
1M-token context**.

### Verified facts (measured 2026-08-06, not assumed)

- **Transcripts.** `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`, one file per
  session. For this project: 2 files, largest **265,443,684 B ≈ 66M tokens** (bytes/4).
- **Free + ≥1M context + genuinely text→text = exactly ONE model** on OpenRouter today
  (live catalog, 399 models, $0 to query):
  `nvidia/nemotron-3-ultra-550b-a55b:free` — 1,000,000 ctx, 65,536 max completion.
  The only other two ≥1M free ids (`google/lyria-3-pro-preview`, `google/lyria-3-clip-preview`)
  are `text+image→text+audio` music models — numerically qualifying, functionally wrong.
  Next tier down is 262,144 ctx with 5 free text models (laguna-xs/s-2.1,
  nemotron-3-super-120b, gemma-4-31b/26b).
- **Consequence:** a 1M window does NOT buy single-shot summarization. 66M tokens is ~66 full
  windows. **Map-reduce is mandatory regardless of model choice** — the 1M model only reduces
  the chunk count, it does not remove chunking.
- **Second consequence:** a one-model pool has no rotation partner. The free-rotation machinery
  needs ≥2 ids to rotate on a 429 / daily cap, so a long run on the single 1M model stalls
  rather than rotating.
- **Live entrypoint confirmed:** `bin/llm-ext` runs `scripts/llm-ext/src/cli/main.ts`, proven
  behaviourally — `main.ts:208` normalises `-`→`_` in flag names and kebab flags do work at
  runtime (`mass-scout-jobs-list --db-path` ≡ `--db_path`). This closes the research report's
  `UNVERIFIED` item on which entrypoint is live.
- **Chunking precedent exists** but is file-list oriented (FFD bin-packing, `scan-folder/core.ts`,
  `index.ts:3077-3079`). A transcript needs a *turn-boundary* chunker, not a file packer —
  design a new one, do not force-fit the old.

### Assumptions I am proceeding under (both are flags; say the word and they flip)

1. **`--min-context 1000000` is the DEFAULT**, honouring the request literally: only the single
   1M free model is eligible. An opt-in `--allow-lower-context` admits the 262k free tier (5
   models) so the job can actually rotate when the daily cap hits. Default = your words;
   the escape hatch = the thing that finishes a 66M-token transcript on a rate-limited free tier.
2. **`--prune aggressive` is the DEFAULT.** Tool-result payloads, pasted file contents and
   thinking blocks are dropped; user turns, assistant prose, tool NAMES with an argument
   summary, and errors are kept. `moderate` (head/tail-truncate each tool result) and `none`
   are available. Rationale: the pruning ratio, not the context window, is what decides whether
   this command is usable — and what a compaction summary needs is the narrative, not the bytes.

### Progress

- **P1 + P2 DONE (2026-08-06).** `scripts/llm-ext/src/session_summary/{transcript,chunker}.ts`
  plus their tests. 26 tests pass, `tsc --noEmit` clean, lint clean — all three re-run and
  confirmed independently, not taken on report. Streaming is real (`createReadStream` +
  `readline`, no `readFileSync`), with a structural test asserting no sync whole-file read and a
  bounded-heap-growth test over a large fixture. `BYTES_PER_TOKEN_ESTIMATE` is one named
  constant, not a scattered `/4`.
- **P3 DONE (2026-08-07)** — `session_summary/model-select.ts` + tests. 40 tests pass in the
  session-summary suite, full repo suite 1775 pass, tsc + lint clean (re-run independently).
  The **modality filter is now a regression test**, not a note: a fixture containing the
  free 1,048,576-context `google/lyria-3-*` audio models asserts they are excluded, because a
  price+context-only filter selects them and the command would fail in a way that looks like a
  model bug rather than a filter bug. Fail-fast on an empty eligible set names the applied
  filters and suggests `allowLowerContext`; two tests assert a paid model can never be selected
  regardless of caller or profile. Tests are fixture-injected — no network.
- **P4-P5 still HELD** pending the user's ruling. Nothing built so far depends on either
  assumption: the prune level is a parameter, the chunker takes a token budget, and the context
  floor is an argument with the 1M default the request asked for.

### Phases (each lands with tests; no phase exceeds 5 files)

- **P1 — reader + pruner ($0, pure, fully unit-testable).** Stream the JSONL line by line (never
  load 265 MB into memory), classify each line by `type` (`user` / `assistant` / `system`),
  extract the content blocks, apply the prune level. Output: an in-memory turn list + a stats
  line (lines read, bytes in, bytes out, prune ratio). Tests over a small fixture transcript.
- **P2 — turn-boundary chunker ($0, pure).** Pack pruned turns into chunks that fit
  `context_budget = min(model_ctx, --max-chunk-tokens)` with a configurable overlap so a topic
  spanning a boundary is not lost. Never split a single turn across chunks unless it alone
  exceeds the budget (then split at line boundaries and mark it `[continued]`). Tests assert
  no-loss, budget respected, overlap present.
- **P3 — model selection ($0, catalog-only).** Query the OpenRouter catalog, filter
  `price==0 AND context_length>=--min-context AND modality=="text->text"`. **The modality filter
  is load-bearing** — without it the lyria audio models qualify numerically. Fail fast with a
  clear message if the eligible set is empty. Reuse the existing free-only enforcement so the
  command cannot spend even on a paid profile.
- **P4 — map-reduce driver.** Summarize each chunk (map), then fold the chunk summaries into one
  session summary (reduce), recursing if the fold itself exceeds the window. Checkpoint after
  every chunk to a resume file so a 429 / daily-cap stall resumes instead of restarting — this
  is the mitigation for the single-model no-rotation problem.
- **P5 — surface + docs.** Register the command in the catalog, write the skill/slash surface,
  add it to the dogfood harness, README.

## Acceptance

- [ ] `llm-ext session-summary --transcript <path>` (and `--session-id` / latest-session default)
      produces a readable compaction-style summary of a real transcript
- [ ] never loads the whole file into memory; verified against the 265 MB transcript
- [ ] $0 by construction — refuses to run on a non-free model even under a paid profile
- [ ] resumes from checkpoint after an interrupted run
- [ ] modality filter proven: lyria ids never selected
- [ ] unit tests + typecheck + lint clean; dogfood covers it
