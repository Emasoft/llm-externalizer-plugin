---
trdd-id: T4MZ8YQR
title: New command — compaction-style summary of a Claude Code session from its JSONL transcript
column: dev
created: 2026-08-06T17:52:00+0200
updated: 2026-08-11T19:09:22+0200
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-11

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

### NEXT ACTION (one step)

Phase B: wire the Phase-A tokenizer/artifact/budget work through `driver.ts` + `index.ts` —
overflow-retry-and-re-split (the model's own rejection is authoritative over the tokenizer's
estimate) and the caller-selected output mode (file path default / direct output opt-in).

Phase A LANDED GREEN — commit `e89456a`, verified independently (vitest 1816 pass / 0 fail /
4 skip, `tsc --noEmit` clean, `eslint` clean). Dependency added: `gpt-tokenizer` ^3.4.0 (MIT,
zero transitive deps, no WASM/native).

### The owner's pipeline spec — AUTHORITATIVE, supersedes the phase descriptions below

Stated 2026-08-11, in order:

1. **Extract the context memory** from the JSONL, dropping JSONL-only bookkeeping that was
   never part of the agent's actual context (`parentUuid`, `uuid`, `sessionId`, `requestId`,
   `cwd`, `version`, `gitBranch`, `userType`, `isSidechain`, `isMeta`, timestamps, hook/plumbing
   system lines). Keep what the model saw: user turns, assistant text/thinking/tool_use, tool
   results — in order, with role attribution.
2. **Write the stripped context to a FILE** — an inspectable on-disk artifact, not memory-only.
   That file is what gets measured and split.
3. **Measure it with a REAL TOKENIZER**, not the bytes/4 estimate. Counting is incremental
   (per turn), never one call over a 265 MB string.
4. **Split by the model's usable INPUT budget**: `context_length − reserved_completion −
   prompt_overhead`. Sizing to the full context guarantees overflow once the reply is generated.
5. **Summarize each chunk in a separate request**, then **re-join into a single file**.
6. **Output mode is the CALLER's choice** — file path (default, protects the caller's context)
   or direct output.

**Why there is no min-context:** the owner's explicit reasoning — the chunking fallback is what
handles a transcript larger than the model's window, so refusing small-context models is
solving the wrong problem. Biggest available free model wins; everything else is a split count.

### SUPERSEDED — do NOT carry forward

- **`--min-context 1000000` as the default.** Removed. There is no implicit floor; models sort
  biggest-context-first and `minContext` is an optional explicit floor only.
- **`--allow-lower-context`.** Removed entirely — meaningless once the floor is gone.
- **`modality === "text->text"` exact match.** Superseded twice by the owner. Final rule: text
  must be PRESENT on both sides of `->` (membership on the `+`-split list, never substring);
  any other modality is irrelevant. Deliberately permissive — it admits the lyria audio models,
  and runtime "returned no usable text" demotes them instead of metadata guessing.
- **`BYTES_PER_TOKEN_ESTIMATE = 4` as the sizing mechanism.** Superseded by a real tokenizer.
- **"a one-model pool has no rotation partner"** as a standing constraint: it was true only
  under the 1M floor. With the floor gone the eligible pool is the whole free text tier, and an
  ordered fallback chain is wired in `driver.ts`.

### Load-bearing gotchas

- A local BPE tokenizer does NOT match nemotron/gemma tokenization. It is an estimate with a
  named safety margin; the **model's own context-overflow error is ground truth** — on overflow,
  re-split smaller and retry rather than trusting the count.
- `--prune aggressive` remains the default: the pruning ratio, not the context window, is what
  decides whether this command is usable. A compaction summary needs the narrative, not bytes.

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
- **P4 DONE (2026-08-07)** — `session_summary/driver.ts` + tests: map each chunk, reduce, recurse
  when the fold itself overflows the window, checkpoint after EVERY chunk. 50 tests pass in the
  session-summary suite (re-run independently), no network in tests.
  The checkpointing is not defensive polish: at the default 1M floor exactly ONE free model
  qualifies, so there is no rotation partner when its daily cap hits and an interrupted run is
  the NORMAL case. Tests therefore assert the parts that make resume trustworthy rather than
  merely present — already-checkpointed chunks are not re-sent to the model; a checkpoint whose
  transcript or prune level no longer matches fails fast instead of folding a summary of one
  input into another; corrupt checkpoint JSON fails fast rather than silently starting over
  (which would look like success while re-spending the whole run); a rate limit raises an
  actionable error naming the checkpoint path instead of retry-looping. The cost chokepoint sits
  BEFORE any I/O — "refuses a non-free modelId before touching the transcript or calling the
  model" — so it cannot be bypassed by a path that forgets to ask.
- **P5 DONE (2026-08-07)** — CLI surface + docs + dogfood. Registered `session_summary` in
  `tools/definitions.ts` and wired it in `index.ts` (transcript resolution, model selection via
  P3's `selectModels`, the real `chatCompletionWithRetry` call injected as P4's `CallModelFn`,
  and `saveResponse` for the report). Transcript/checkpoint path resolution lives in its own new
  module (`session-summary-resolve.ts`), deliberately OUTSIDE `session_summary/` — P1-P4 stayed
  untouched. README counts moved (43→44 total, 20→21 core/utility) per `doc-consistency.test.ts`,
  plus a `session_summary` write-up with every flag grounded in real `--help` output. Added to
  `tests/dogfood/dogfood_test.py`'s opt-in live smoke (new `sample-session.jsonl` fixture) —
  `--help` coverage for every command (including this one) is already automatic via the dynamic
  verb parser. Full suite 1795 pass / 0 fail / 4 skip (re-run independently), tsc + lint clean,
  `./bin/llm-ext session-summary --help` exercised for real against the live binary.

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
- **P5 DONE — surface + docs.** Registered the command in the catalog, wrote the README surface
  docs, added it to the dogfood harness.

## Acceptance

- [ ] `llm-ext session-summary --transcript <path>` (and `--session-id` / latest-session default)
      produces a readable compaction-style summary of a real transcript — **NOT yet run against a
      real transcript**: P5's verification scope was explicitly `--help` only (no live
      summarization, to avoid spending free-tier quota). Reachability proven
      (`./bin/llm-ext session-summary --help` exercised against the live binary); an actual live
      run is the natural next step, e.g. via `DOGFOOD_LIVE=1`.
- [ ] never loads the whole file into memory; verified against the 265 MB transcript — P1's
      structural test (no sync whole-file read) is unit-verified; the real 265 MB transcript has
      not been run through the wired-up CLI.
- [x] $0 by construction — refuses to run on a non-free model even under a paid profile.
      `summarizeSession()` calls `assertFreeOnlyModel(true, …)` with a HARDCODED `true`, and P5's
      CLI wiring threads no caller-supplied override — unit-verified in `driver.test.ts` +
      `model-select.test.ts`.
- [x] resumes from checkpoint after an interrupted run — unit-verified in `driver.test.ts` (P4);
      P5 exposes it via `--checkpoint` (deterministic default) and `--resume` (fail-fast if no
      matching checkpoint exists). Not yet exercised end-to-end against a real interrupted run.
- [x] modality filter proven: lyria ids never selected — regression test in `model-select.test.ts` (P3).
- [x] unit tests + typecheck + lint clean; dogfood covers it — full suite 1795 pass / 0 fail / 4
      skip, `tsc --noEmit` clean, `eslint` clean (all re-run independently); dogfood's dynamic
      `--help` verb parser covers `session-summary` automatically, plus a new opt-in
      (`DOGFOOD_LIVE=1`) live-smoke check with a dedicated `sample-session.jsonl` fixture.

Added 2026-08-11 with the owner's pipeline spec:

- [x] no implicit context floor; biggest free model wins, deterministic tie-break; ordered
      fallback chain on delisted / no-longer-free / cap-exhausted / no-usable-text — suite
      1805 pass / 0 fail / 4 skip, typecheck clean.
- [x] the stripped context is written to an inspectable FILE before measurement — streaming
      write, no whole-file buffering (Phase A, `e89456a`).
- [x] chunk sizing uses a REAL tokenizer, counted incrementally — `gpt-tokenizer`'s `countTokens`
      per turn; `BYTES_PER_TOKEN_ESTIMATE` is gone, replaced by `estimateTokens` +
      `TOKEN_ESTIMATE_SAFETY_MARGIN` (Phase A, `e89456a`).
- [x] chunks are sized to `context_length − reserved_completion − prompt_overhead` via
      `computeUsableTokenBudget` (Phase A, `e89456a`).
- [ ] a context-overflow error FROM THE MODEL triggers a re-split rather than a failure —
      Phase B. This is the half that makes the tokenizer's inexactness safe: a local o200k
      tokenizer does not match nemotron/gemma, so the margin reduces overflow but cannot
      eliminate it.
- [ ] the caller chooses the output mode: file path (default) or direct output — Phase B.

## Approval log

- 2026-08-11T19:09:22+0200 — `human_review` → `dev`. The owner supplied a new pipeline
  specification for this command (tokenizer-measured sizing, on-disk stripped artifact,
  usable-budget splitting, caller-selected output mode) and the reasoning for removing the
  context floor. That specification IS the review verdict: the command is not done. Moved back
  to `dev` rather than left in `human_review`, so the board stops claiming it awaits a human.
