---
trdd-id: HKXRJT9X
title: Admit catalog-verified $0 models without a colon-free suffix into free mode
column: superseded
created: 2026-08-26T04:47:40+0200
updated: 2026-08-27T14:57:11+0200
current-owner: llm-externalizer-session
task-type: feature
min-approval-requirement: user
superseded-by: [V32LB992]
relevant-rules: []
---

# TRDD-HKXRJT9X — admit $0 non-`:free` models (the `stealth/ox-alpha` class)

User question (2026-08-26): *"the llm-ext compact functionality is extremely
slow. there are very fast free models now on openrouter, like `ox-alpha`. why
are you not using them?"*

## 0. Verified facts (read from source + the live catalog, 2026-08-26)

- `stealth/ox-alpha` exists and is genuinely free: `pricing.prompt = 0`,
  `pricing.completion = 0`, `context_length = 1_048_576`,
  `top_provider.max_completion_tokens = 131_072`, `supported_parameters`
  includes `response_format`, `reasoning`, `tools`.
- It is EXCLUDED from free mode by a **syntactic suffix rule**, not by price
  or quality:
  - `benchmark/free-mode.ts:22` — `isFreeSuffixModelId(id) = id.endsWith(":free")`,
    documented as "the ONE predicate for what the free_only chokepoint admits".
  - `benchmark/pick.ts:405` — `applyFreePoolToSettings` **fails fast** on any
    non-`:free` id, because `config.ts::validateProfile` rejects one under
    `free_only`; writing it would produce a settings.yaml that no longer loads.
  - `benchmark/pick.ts:120-131` — `passingFreePoolIds` therefore only ever
    returns `:free` ids, so the auto-populated pool structurally cannot contain
    a $0 stealth model.
- The codebase **already knows this class exists**: `benchmark/discover.ts:585`
  `isFreeModeEligible` = "a `:free` id **OR** a $0 catalog price", and its own
  comment names `openrouter/owl-alpha` as the motivating example. So one
  predicate accepts $0 non-suffixed models and the other (the one gating what
  can be SENT and PINNED) still requires the suffix. That inconsistency is the
  defect.

## 1. The compact-slowness mechanism — CORRECTED (read from source 2026-08-26)

An earlier draft of this card (and what was first told the user) said compact is
slow because small-context pool members force many chunks, so a 1M-context model
would collapse the chunking. **That is WRONG, and `session_summary/driver.ts`
had already measured it.** Recorded here so the error is not re-derived:

- `DEFAULT_MAX_CHUNK_TOKENS = 25_000` is a **hard cap, INDEPENDENT of the
  selected model's context window** (driver.ts:117-147). Its header records the
  live measurement: a **1M-context free model** handed a single ~150k-token
  chunk *"degenerated to echoing a raw line back instead of summarizing"*.
  Quality collapses long before the context LIMIT. So a bigger window does not
  reduce chunk count — the cap is competence-derived, not window-derived.
  (Lowered 50k → 25k on 2026-08-12 because the map phase now runs CONCURRENTLY,
  where smaller chunks are strictly better.)
- Latency is **not proportional to chunk size**: a 4x smaller (6k) chunk was no
  faster and produced 80 aborts instead of 13; a `max_tokens=8` request still
  costs ~35s. *"Free-tier latency is dominated by queueing and contention, not
  by how much the model generates."* (driver.ts:246-250)
- Wall-clock = the **slowest** chunk, not the average: measured per-chunk
  latency on the free tier spreads 4.4x — 91/185/262/312/475/718/1234/1478s.
  Concurrency, hedging (`HEDGE_AFTER_MS` races a second model at 60s) and the
  600s backstop already exist to cut that tail.
- driver.ts states the residual constraint outright: *"the constraint is the
  free tier's per-request latency, which no chunking, deadline, concurrency or
  fan-out setting can move."*

**So the user's own framing was the right one and mine was not:** the lever is a
genuinely FASTER, less-contended free endpoint — per-request latency — not a
bigger context window. `stealth/ox-alpha`'s 1M window is irrelevant to compact
speed; its value would be latency and queue depth.

**Step 1 (blocking, re-aimed):** measure `stealth/ox-alpha`'s per-request
latency and abort/retry rate on real 25k compact chunks against the current
pool's measured distribution above. It earns admission only if it materially
beats that distribution. Bigger context is NOT a justification and must not be
cited as one.

## 2. Design (only if step 1 confirms the premise)

Widen the free-only chokepoint from "suffix" to "suffix OR catalog-verified $0",
reusing the predicate that already exists rather than adding a second one:

- `isFreeSuffixModelId` → replaced at its gate sites by `isFreeModeEligible`
  (id suffix OR `isZeroCostPriced(input, output)`).
- `config.ts::validateProfile` accepts a non-`:free` id in `free_models` ONLY
  when the live catalog prices it at exactly $0.
- `applyFreePoolToSettings` stops failing fast on such an id, for the same
  reason.
- **The money invariant is preserved by a send-time re-check, not by trust:**
  before any send under `free_only`, re-verify the catalog price is $0 and
  FAIL FAST if the model has become priced. A stealth model turning paid must
  abort the call, never silently bill.
- A `:free` id keeps its historical syntactic guarantee and needs no price
  lookup — the cheap path stays cheap.

## 2b. Data-egress risk — decide this BEFORE adopting any stealth endpoint

`stealth/ox-alpha` is a **cloaked/stealth** endpoint. That class is
conventionally free *because* the provider retains prompts for evaluation. The
tool this would most benefit — `session_summary` / compact — sends whole session
TRANSCRIPTS: source code, paths, and anything the redactor does not catch.

So admitting this class is not only a cost decision, it is a **data-egress**
decision, and it must be made knowingly rather than inherited as a side effect
of a pool-eligibility fix. Options to put to the user: exclude stealth vendors
from the auto-populated pool while allowing an explicit opt-in pin; or admit
them only for tools whose payload is not user code. Do NOT quietly auto-populate
a stealth endpoint into `free_models`.

## 3. Risk (why this is `min-approval-requirement: user`)

This touches the hard cost-safety invariant: today "free" is guaranteed by a
string suffix that cannot change under us; after this change, for one class of
model, it is guaranteed by a catalog price that CAN change. The send-time
re-check is what makes that safe, so it is not optional — it is the feature.

## 4. Acceptance

- [ ] Step 1 measurement done; premise confirmed or TRDD re-scoped/withdrawn.
- [ ] `isFreeModeEligible` is the single predicate at every free-only gate;
      `isFreeSuffixModelId` retained only where the suffix itself is the fact.
- [ ] Send-time $0 re-verification with fail-fast on a now-priced model.
- [ ] `validateProfile` + `applyFreePoolToSettings` accept catalog-$0 ids.
- [ ] Real tests: a $0 non-`:free` id is admitted, pinned, and sent; the same id
      priced > $0 is REFUSED at send time (no mocking of the unit under test).
- [ ] Pool auto-population can select `stealth/ox-alpha`-class models.
- [ ] Docs: the free-mode contract now says "suffix OR catalog-$0, re-checked
      at send"; the `:free`-only wording is corrected wherever it appears.
- [ ] Build + full suite + lint green; dogfood; publish.

## 6. STEP 1 MEASURED — the premise is REFUTED (2026-08-26)

Step 1 was run against the live API on a real production-shaped chunk
(provider-reported `prompt_tokens: 24_656` — i.e. the actual 25k
`DEFAULT_MAX_CHUNK_TOKENS` payload, not an estimate). Raw rows:
`reports/model-matrix-bench/20260826_112129+0200-model-matrix.md`, reproducible
with `uv run tests/bench/model_matrix_bench.py --pool`.

**ox-alpha is NOT a fast model** — every observation of it is at or worse
than the pool's middle. (Not "the slowest": see the licensing note below.)

| model | sec | content chars | reasoning chars |
|---|---|---|---|
| nvidia/nemotron-3.5-content-safety:free | 5.6 | **17** (junk) | 1017 |
| poolside/laguna-s-2.1:free | 7.9 | 1189 | 0 |
| minimax/minimax-m3:free | 11.2 | 4843 | 0 |
| liquid/lfm-2.5-2.6b:free | 11.7 | 1656 | 4289 |
| cohere/north-mini-code:free | 13.7 | 2280 | 5389 |
| *(pool median)* | *25.9* | | |
| nvidia/nemotron-3.5-lightning:free | 85.6 | 2353 | 13873 |
| **stealth/ox-alpha** | **97.5** | 4602 | 10611 |

So the feature this card proposes would admit, at real cost-safety expense, a
model at or worse than the pool's middle on every observation of it. It cannot
improve compact. **This card is WITHDRAWN as specified.**

### What this measurement does and does NOT license

Stated precisely, because the numbers above are **n=1 per model** and the same
sweep measured `dots-3-note-preview` at **66s and then 297s** — a 4.5x swing on
one model, one payload:

- **LICENSED:** "ox-alpha is not fast." Every observation of it (3x ~28s
  returning ZERO content at max_tokens=900, then 97.5s at 4000) is at or worse
  than the pool's middle. That is enough to kill this card, which rested
  entirely on it being FASTER.
- **LICENSED:** the card's "91..1478s" figure is dead. Refuting a distribution
  needs far less evidence than establishing one, and nothing observed came
  within 5x of 1478s.
- **NOT licensed:** the exact ranking ("the slowest"), or "the pool median is
  25.9s" as a stable property. At n=1 against a 4.5x intra-model swing, ox-alpha
  and `nemotron-3.5-lightning` (44.4s) may not even be correctly ORDERED. Anyone
  pruning the pool on these numbers must re-measure with replication first.
- **NOT licensed as a claim about the SELECTOR:** the reachability figures below
  come from bare `urllib` calls with no rotation, cooldown consult, hedging or
  retry — i.e. MY path, not the product's. The product may already skip or
  successfully retry these. Note also that this sweep itself issued ~40 free-tier
  requests, so some 429s may be self-inflicted.

Two corrections it leaves behind, both verified, both worth more than the card:

1. **The "91/185/…/1478s" distribution quoted in §1 DOES NOT REPRODUCE.** Today
   the reachable pool runs 5.6–85.6s, median 25.9s on the same chunk size. That
   figure came from an older pool and must not be re-cited as current evidence
   for "free-tier latency is unfixable".
2. **41% of the configured pool did not answer a naive direct call.**
   7/17 members fail instantly: 4x HTTP 429 (`free-models-per-day`), 2x HTTP
   403 (`thinkingmachines/*` — this account has no access at all), 1x Nvidia
   `ResourceExhausted`. The two **403s are the robust part** — an account-access
   fact, not a transient: those models cannot serve this account at all. The
   429s are weaker evidence (possibly transient, possibly self-inflicted).
   Separately, `free-cooldowns.json` held **0 active cooldowns** with every
   record expired. It is TEMPTING to conclude "the selector therefore believes
   all 17 are healthy" — but that was never observed: the selector was never
   watched choosing. Establishing it requires instrumenting the real selection
   path, not reading its state file.

   Even so, a pool where 2 members are permanently inaccessible and one
   (`content-safety`) returns 17 chars of content is worth auditing before
   anyone concludes latency is irreducible.

Follow-up work belongs in a NEW card scoped to pool hygiene, not here:
**TRDD-V32LB992** now carries it.

3. **`--profile free` is NOT a product bug — I initially reported it as one.**
   `overrideActiveProfile()` (index.ts:633) resolves ONLY against
   `activeSettings.profiles[name]`; there is no built-in fallback. The
   machine-owned names work because `generateDefaultSettings()` (config.ts:630)
   WRITES `free`/`paid`/… into a **fresh** settings.yaml with `active: free`
   and `allow_paid_models: false`. This machine's settings.yaml is hand-authored
   and predates that, so it has 5 custom profiles, no machine-owned defaults,
   and no top-level `allow_paid_models` — hence the free pool sits inside a
   PAID ensemble as a 402 fallback rather than being selectable.
   The one genuine defect was the `--profile` help text claiming "built-in, or
   a key under `profiles:`", which describes a fallback that does not exist.
   Fixed; the lookup is keys-only.

## 5. Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-26T04:47:40+0200 | created → todo | From the user's ox-alpha question. Exclusion cause VERIFIED from source; the compact-slowness causal claim is NOT yet measured and is step 1. Filed separately from the v13.6.0 text-tools release because it changes the cost-safety invariant. |
| 2026-08-26T10:48:00+0200 | §2b RULED by USER | *"i don't care about privacy. i don't share tokens, passwords or api keys anyway. send the transcripts anyway."* Data-egress objection to stealth endpoints is WITHDRAWN by the owner. Stealth vendors may be auto-populated into `free_models`; no per-tool payload carve-out is required. The egress trade is accepted knowingly — this line is the record of that, so a later session does not re-litigate it as an oversight. |
| 2026-08-26T10:48:00+0200 | §2 send-time check REAFFIRMED by USER | *"you must of course always check if a model is still free before sending the request."* The catalog-$0 re-verification before every `free_only` send, with fail-fast on a now-priced model, is CONFIRMED non-optional. Note the asymmetry this creates and do not "simplify" it away: egress is waived, cost-safety is NOT. |
| 2026-08-26T11:10:00+0200 | todo -> superseded | Step 1 MEASURED against the live API: ox-alpha is 97.5s vs a 25.9s pool median -- the SLOWEST working model, not a fast one. The card's own premise is refuted, so the cost-safety invariant is NOT worth changing for it. See section 6. Superseded by pool-hygiene work (41% of the pool is dead and the cooldown store does not know).
