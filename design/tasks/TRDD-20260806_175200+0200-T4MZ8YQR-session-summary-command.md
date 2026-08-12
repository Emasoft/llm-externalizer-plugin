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

### ⏵ RELEASED v12.0.0 (2026-08-11 23:47Z) — state at handoff

**SHIPPED.** `v12.0.0` tagged, GitHub release live, 0 unpushed commits. Major bump because the
`bin` repoint changes what `llm-externalizer` executes (legacy positional args break) and the
release completes the CLI-only direction. `publish.py --check-only` passed all gates first;
the skillaudit findings are FPs on `benchmark/security-triage/dataset.*`, which is a corpus of
deliberately-malicious fixtures — the scanner flagging them is correct behaviour (#41 advisory).

**IN FLIGHT AT HANDOFF — post-fix quality verification.** Running
`session-summary` on this session's transcript with a fresh checkpoint, to answer the owner's
question "has the free model been verified able to handle the task?". Honest status: the
nine-section schema WAS produced end-to-end once (328 KB, all sections, verbatim intact —
`"i granted  permission"` kept its double space), but that was BEFORE the queue-operation
extraction fix, which adds ~9 more user messages that must now be reproduced verbatim. So
quality after the fix is NOT yet verified. Counter-evidence worth respecting: nemotron has
produced an echo, a `finish_reason=error`, and repeated `finish_reason=empty` across tonight's
runs, and takes ~28 min/chunk. "The free model can do it" rests on ONE clean run.

What the verification must show: (a) the newly-captured mid-turn messages present verbatim
(`delete the whole .serena folder`, the MCP ban, `find a way to make it work`) — 0/6 before the
fix; (b) zero `[janitor-heartbeat]` noise in the user-message sections; (c) all nine sections
still produced under the larger verbatim load; (d) completion at all.
If (c) or (d) fail, the honest response is a follow-up release lowering per-chunk load — NOT
relaxing the verbatim rule, which is the feature.

### ✅ POST-FIX QUALITY VERIFIED (2026-08-12 02:20) — answers "can the free model do it?"

Live run AFTER the queue-operation extraction fix.
Report: `reports/llm-externalizer/20260812_022051+0200-session_summary-cc0932.md`

| check | before fix | after fix |
|---|---|---|
| the 5 previously-lost user messages | 0/5 | **5/5 PRESENT** |
| `[janitor-heartbeat]` noise | 17 | **1** |
| output size | 328 KB | **21 KB** |
| parts joined | 3/3 | 3/3 |
| nine-section schema | ✓ | ✓ |
| prune ratio | 0.103 | **0.076** |

**The 15× size drop is the OPPOSITE of loss.** The old 328 KB was bloated by faithfully
reproducing heartbeat prompts and skill-doc injections verbatim — the machine noise WAS the
bulk of the "summary". 21 KB now carries strictly MORE real information. The single surviving
`janitor-heartbeat` string is legitimate content: the summary's own Errors-and-Fixes table
describing the bug fixed tonight.

**VERDICT: the free model IS capable of the task.** Its weakness is RELIABILITY, not capability
— this run still needed retries through a `finish_reason=empty` and a `finish_reason=error`.
Tally across the night on `nemotron-3-ultra:free`: 1 echo, 2 empties, 2 errors — roughly a third
of attempts need a retry. That is what the concurrency work addresses: sequentially a failed
attempt adds its full wasted duration to the total; concurrently it overlaps the chunks still
working and stops extending the critical path.

### MEASURED THROUGHPUT + THE PARALLELISATION OPPORTUNITY (2026-08-12)

Measured on the completed run (23:11 → 00:11): **3 chunks / ~150k pruned tokens in 60 min**
= ~20 min per 50k chunk. Extrapolated: a **666k-token** context is ~14 chunks ≈ **4.5–5 hours
SEQUENTIALLY** (more with retries; `--prune aggressive` cut this session's transcript to 10.3%,
so pruning usually dominates the raw JSONL size).

**That wall-clock is an ARTEFACT OF SEQUENTIAL PROCESSING, not an inherent cost — and the
owner's redesign is exactly what makes fixing it safe:**
- chunks are turn-atomic, so each is independently summarizable;
- there is no model fold, so no chunk depends on another chunk's summary;
- the join is deterministic and order-based.

So chunks may be sent CONCURRENTLY with no correctness change at all. Wall-clock collapses to
roughly one chunk's time — **~20–30 min for 666k** — bounded by free-tier rate limits rather
than by token count. The existing free-rotation + cooldown machinery already handles 429s.
Proposed shape: bounded concurrency behind a `--concurrency` flag with a modest default, so the
free tier is not hammered by default. NOT IMPLEMENTED — awaiting the owner's go-ahead.

Note this only became possible when the model-fold was removed: with a fold, chunk summaries had
to be collected before the reduce step could run, and a mid-run downgrade re-chunked the
remainder.

### ✅ FREE-TIER CONCURRENCY CEILING — MEASURED, NOT ESTIMATED (2026-08-12 02:29)

The account's OpenRouter `rate_limit` field is DEPRECATED (`requests: -1`), so the documented
limit is unusable and the only trustworthy number is a measured one. Probed the live account
against `nvidia/nemotron-3-ultra-550b-a55b:free` with bursts of tiny (`max_tokens: 8`) requests,
so the burst measures ADMISSION, which is what a 429 gates on, rather than generation.

| burst | result |
|---|---|
| **32 concurrent** | **32/32 HTTP 200.** Zero 429. No `x-ratelimit-*` headers returned at all. |
| **64 concurrent** | 62/64 HTTP 200, **2× 429** — `x-ratelimit-limit: 20`, `x-ratelimit-remaining: 0`, `x-ratelimit-reset: 1786494540000`. Rejections came back in 0.2s. |

**Answer to "do free models accept dozens in parallel?" — YES. Dozens is fine; 32 is clean, 64
is where it breaks.** My earlier "realistically 10–16" was too pessimistic by ~2×.

**THE LOAD-BEARING FINDING: that 429 is TRANSIENT, not a daily cap.** Converting the reset
timestamp shows it was already **7 seconds in the past** when the burst finished — a sub-minute
rolling window. This is a correctness trap, not a tuning note: if `classifyUnavailable`
(`free-rotation.ts`) reads this 429 as daily-quota-exhausted it will DEMOTE the model, and a
single parallel burst then walks the entire free pool in seconds — converting a 200 ms hiccup
into a total run failure with "all candidates exhausted". The discriminator must be the reset
timestamp's proximity: a genuine daily cap carries a reset many hours out (UTC midnight) and is
cleanly distinguishable from one already elapsed.

**~35 s PER-REQUEST FLOOR, INDEPENDENT OF OUTPUT SIZE.** A request generating 8 tokens still
took ~35 s; successful large-chunk requests took 35–42 s. Latency is queue/cold-start dominated,
not generation dominated. Two consequences:
- splitting into smaller chunks does **not** reduce total time *sequentially* — each added chunk
  re-pays the ~35 s floor. Smaller chunks only pay off when they run **concurrently**.
- parallel wall-clock ≈ *slowest single chunk + stagger*, not the sum.

**Stagger corrected from 3 s to ~250 ms.** My original 3 s figure modelled the risk as sustained
throughput; the measurement shows the risk is the instantaneous admission burst against a 20-slot
sub-minute bucket. 3 s × 16 workers would have added ~45 s of dead time per run for no benefit.

**Default concurrency 12–16** — deliberately inside the measured-clean zone rather than at the
64-request cliff, leaving headroom for the ensemble's other traffic and for models with tighter
buckets. User-overridable; `--concurrency 1` must reproduce sequential exactly.

### REMAINING AFTER HANDOFF

1. Finish/inspect the verification run above.
2. **File the janitor issue** (owner-requested): how to use `llm-ext session-summary` to compact
   ANY Claude Code session at $0. Repo `Emasoft/ai-maestro-janitor`. No existing issue covers it;
   #190 (large-transcript session cost) and #224 (post-`/clear` resume state) are adjacent and
   worth citing. MUST open with the identity line naming which Claude authored it, and MUST NOT
   contain a bare `@name` outside a code span.
3. `9487d9a` fixes the package.json self-description ("MCP server for LLMs" shipped in 12.0.0) —
   committed, unpublished; rides the next release.

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

### Compaction-equivalence rework (2026-08-12) — what the live runs actually taught

The command "worked" (real summary, 4,353 B) while still failing the ORIGINAL request, which
said *"compaction like"*. Validating "is this a summary?" is a weaker test than "is this a
compaction?", and the gap only showed when compared against Claude Code's own compaction output.

1. **Nine-section schema** replaces the five-section report. Claude Code's compaction is a
   RESUMPTION HANDOFF: Primary Request and Intent · Key Technical Concepts · Files and Code
   Sections · Errors and Fixes · Problem Solving · **All User Messages (verbatim)** · Pending
   Tasks · Current Work · Next Step.
2. **No model fold.** The reduce phase was a model call that decided what to keep — the exact
   threat to the verbatim requirement. Chunk summaries are now JOINED IN CODE. "No facts lost in
   the merge" became true by construction, and the recursive fold-overflow machinery, reduce
   levels, reduce batch-packer and fold-only error paths all deleted with it.
3. **Turn-atomic chunking.** A boundary may fall ONLY between turns. The old "split an oversized
   turn at line boundaries and mark it `[continued]`" hatch is deleted: split a turn and chunk N
   describes an action whose result is in N+1 while N+1 describes a result whose cause it cannot
   see. No prompt repairs information destroyed at split time.
4. **Images dropped at every prune level**, replaced by `[image omitted]`. A base64 screenshot
   gives a text model zero information while EVICTING real content from the chunk — a quality
   fix, not a cost one.
5. **THE BUG ONLY A LIVE RUN COULD FIND — mid-turn user messages were silently discarded.**
   A message sent WHILE THE ASSISTANT IS WORKING is recorded as `type: "queue-operation"` with
   its text at the TOP-LEVEL `content` field, not `type: "user"`. The extractor keyed on `type`
   and took only `"user"`. Measured: `"serena"` appeared **0 times** in a 328 KB summary although
   the owner had said *"delete the whole .serena folder"*; also lost were the MCP ban,
   *"find a way to make it work"*, *"the merge should not be made by the model"*, and
   *"embedded images should be dropped"*.
   Inverted in the worst way: `[janitor-heartbeat]` cron fires ARE type `"user"`, so machine
   noise filled the verbatim section while human intent vanished from it.
   **1865 unit tests could not see this** — no fixture contained the shape, because it only
   occurs when a real person interrupts a working agent.
   Verified after the fix against the REAL transcript (not fixtures): 6/6 lost messages present,
   0 heartbeat fires, user turns 62 → 53 as 9 skill-doc loads drop out.

**Cost note measured 2026-08-11:** under the verbatim schema, OUTPUT size scales with INPUT size
(every user message must be reproduced), so large chunks are now doubly expensive — ~28 min per
50k-token chunk on `nemotron-3-ultra:free` vs ~90 s for the old fixed-size summary. The 50,000
default was chosen when output was fixed-size; 20–25k is likely better now. Not changed yet —
that should be a measured decision, not a second guess.

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

- [ ] `llm-ext session-summary --transcript <path>` produces a readable compaction-style summary
      of a real transcript — **RUN 2026-08-11, STILL NOT MET.** The plumbing all works: it
      selected `nvidia/nemotron-3-ultra-550b-a55b:free` (1,000,000 ctx), read 3,658 lines, pruned
      to 0.103, packed 1 chunk, checkpointed, wrote a report, exited 0. **But the summary body is
      a single raw pruned turn from the transcript, not a summary** — 941 B of output, the last
      `tool_use` line echoed back
      (`reports/llm-externalizer/20260811_203117+0200-session_summary-c77703.md`).
      The model logged `Empty response (finish_reason=empty)` and retried up to 15× on the SAME
      model instead of triggering the documented no-text fallback to the next ranked candidate.

      ROOT CAUSE (found by reading the source, not the logs): chunk sizing used the whole window
      budget (`contextLength − maxCompletion − overhead` ≈ 934k), so the entire ~150k-token
      transcript went to the model in ONE request. A context window governs what FITS, not what a
      model can summarize WELL — free models collapse into echoing long before the limit.
      The `retrying (1/15)` lines came from the OpenRouter CLIENT layer, not the driver:
      `driver.ts:368` already threw `no-text` and `:373` propagated it for fallback without
      retrying, so the driver never saw an empty string. My first diagnosis blamed the fallback
      chain and was wrong.

      **RESOLVED 2026-08-11 — see the box below. Kept here because the defect shape is the
      lesson: five phases of green unit tests could not catch it, which is why this criterion
      exists.**

- [x] **MET 2026-08-11 (second live run, `520b653`).** Real compaction summary produced:
      3 chunks, 3,918 lines read, prune 0.103, 4,353 B / 70 lines of structured output —
      *User Requests · Decisions Made · Files Changed (commit table) · Commands Run · Outcomes* —
      with accurate specifics (the kebab/snake false positive, the board triage counts, the nine
      commits). Report:
      `reports/llm-externalizer/20260811_210710+0200-session_summary-13d13e.md`.
      Fixes that got it there: chunk cap (default 50,000, `--max_chunk_tokens` to override),
      echo-rejection routed through the model-fallback path, and non-zero exit when every
      candidate is exhausted. Contrast with the failed run: 1 chunk → 3 chunks, 941 B echo →
      4,353 B summary.
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
- [x] a context-overflow error FROM THE MODEL triggers a re-split rather than a failure —
      Phase B (`21e2603`). This is the half that makes the tokenizer's inexactness safe: a local
      o200k tokenizer does not match nemotron/gemma, so the margin reduces overflow but cannot
      eliminate it; the model's rejection is therefore authoritative over our count. Bounded
      halving — a chunk that still overflows when it cannot be split further fails loudly rather
      than looping. Overflow deliberately does NOT swap models (sizing ≠ availability).
- [x] the caller chooses the output mode: file path (default) or direct output — Phase B
      (`21e2603`). `--stdout` is a NEW flag, not an overload of the existing `--output` (which
      means output DIRECTORY); overloading would have made "where does the summary go" depend on
      the value's shape. Verified on the live binary after rebuild.

## Approval log

- 2026-08-11T19:09:22+0200 — `human_review` → `dev`. The owner supplied a new pipeline
  specification for this command (tokenizer-measured sizing, on-disk stripped artifact,
  usable-budget splitting, caller-selected output mode) and the reasoning for removing the
  context floor. That specification IS the review verdict: the command is not done. Moved back
  to `dev` rather than left in `human_review`, so the board stops claiming it awaits a human.
