---
trdd-id: ec45c66f-1ab9-4425-8515-8073dd8aa244
title: Reasoning cost regression — cluster reasoning off, A3 cap revert, configurable effort
status: completed
created: 2026-05-25T11:40:31+0200
updated: 2026-05-25T11:47:13+0200
---

# TRDD-ec45c66f — Reasoning cost regression remediation

**Filename:** `design/tasks/TRDD-20260525_114031+0200-ec45c66f-reasoning-cost-regression.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

## Incident

User: "the ensemble using reasoning models is ok, but not for the mass scouting
models or the clustering synonyms models. But we always used reasoning models
without problems. even the biggest scan of entire project folders with 10k files
were under $1.. what happened that made the prices grow 10x?"

OpenRouter export confirmed per-call output blew up: gemini-3.1-flash-lite-preview
generated ~53K output tokens/call (26.9K completion + 26.7K reasoning) in the
spike hour. A scan answer should be hundreds-to-low-thousands.

## Root cause (git-confirmed)

Three code-side cost inflators, ranked:

1. **cluster_synonyms forces `reasoning: xhigh` + `max_tokens: 65535`.**
   `csRawLlmCall` (index.ts ~9430) → `chatCompletionWithRetry` →
   `chatCompletionSimple`, which applies `reasoningLadderForModel` (xhigh) and
   `max_tokens: options.maxTokens ?? resolveDefaultMaxTokens()`. cluster passes
   `maxTokens: 65535`. So every cluster LLM call on a reasoning primary
   (deepseek-v4-pro) burns ~16-27K reasoning tokens for a tiny JSON answer.

2. **A3 (commit 0eed8d2, TODAY) raised the ensemble output cap 32K → catalog 65K**
   for models NOT in KNOWN_MODEL_LIMITS. The user's ensemble
   (deepseek-v4-pro / gpt-5.4-nano / gemini-3.1-flash-lite-preview) is not in
   the table, so pre-A3 it got DEFAULT_MODEL_LIMITS.maxOutput = 32_000; post-A3
   it gets the catalog's `max_completion_tokens` (65K). A3's design note —
   "Requesting more output is harmless, the model self-limits" — is FALSE for
   reasoning models, which spend the budget thinking.

3. **`reasoning: {effort: "xhigh"}` on every ensemble call** (reasoningLadderForModel,
   index.ts:1413; reasoning enabled 2026-04-10). xhigh = maximum thinking
   tokens, all billed (we discard the trace but still pay).

Test-suite amplification (244 ensemble ops/hr) was fixed separately in
TRDD-e82f2c49 (commit 31ce212).

## Already clean — do NOT touch (verified)

- **mass_scout** (`scout.ts` reqBody): model + messages + response_format +
  temperature 0.1. NO reasoning, NO max_tokens. Data: qwen 0 reasoning tokens.
- **security_scan** (`judge.ts` reqBody, line 329): model + messages +
  response_format + temperature 0.1. NO reasoning, NO max_tokens. Its calibrated
  detection (#90/#93/#94/#95/#96) is INDEPENDENT of the index.ts ladder — so the
  ladder changes below cannot relax security quality. Hard rule honored:
  "Never relax security strictness / quality gates."

## Changes

1. **Per-call reasoning opt-out (Fix #1).**
   - Add `reasoning?: "off" | "low" | "medium" | "high"` to `chatCompletionSimple`
     and `chatCompletionWithRetry` options.
   - In `chatCompletionSimple` ladder selection (index.ts ~2886): when
     `options.reasoning === "off"`, use `[null]` (no reasoning field), regardless
     of backend.
   - `csRawLlmCall` (cluster) passes `reasoning: "off"` + `maxTokens: 4096`
     (clustering/canonicalization answers are small JSON).

2. **A3 cap revert to min-semantics (Fix #2).**
   - `resolveEnsembleModelLimits`: `maxOutput = catalog present ?
     min(catalog, calibrated) : calibrated`, where calibrated = known[id] ??
     fallback. The catalog can only LOWER the budget (respect a provider that
     tightened its cap), NEVER raise it above our calibrated value. Restores the
     pre-A3 32K ceiling for non-table models; keeps the intentional 65K for table
     models (gemini-2.5-flash etc.).
   - Rewrite the false "self-limits is harmless" module note.
   - Update ensemble-limits.test.ts cases that asserted catalog-preferred (raise)
     to assert min-semantics (catalog-can-only-lower).

3. **Configurable reasoning effort, default xhigh→high (Fix #3).**
   - `DEFAULT_REASONING_EFFORT` from env `LLM_EXT_REASONING_EFFORT`
     (xhigh|high|medium|low|off), default **high** (down from xhigh).
   - `reasoningLadderForModel` builds its top rung from DEFAULT_REASONING_EFFORT;
     "off" ⇒ `[null]`. Keeps the downgrade-on-reject cache.
   - Export `reasoningLadderForModel` + `DEFAULT_REASONING_EFFORT` for offline
     unit tests.
   - security_scan + scout unaffected (own fetch, no reasoning).

## Tests (offline, zero OpenRouter spend)

- ensemble-limits.test.ts: catalog above calibrated → capped at calibrated;
  catalog below → uses catalog; table model keeps its high cap; unknown model
  capped at 32K default.
- new reasoning-ladder unit test: default top rung is "high" not "xhigh";
  `LLM_EXT_REASONING_EFFORT=off` ⇒ `[null]`; `=medium` ⇒ medium top rung.
- cluster wiring: csRawLlmCall constructed with reasoning:"off" + maxTokens 4096
  (assert via the options object / a captured-body fake).
- Full `npm test` stays green; tsc + eslint clean; no real calls.

## Docs

- README + TESTING.md: document `LLM_EXT_REASONING_EFFORT` and that scout/cluster
  never reason.
- discover / help: surface the effort setting.

## Out of scope / follow-up
- Re-running the #96 security-triage benchmark to reconfirm detection (needs
  budget; security_scan path is UNCHANGED so no regression expected).
- A6/A7.

## Verification (done)
- tsc + eslint clean; full `npm test` 895 passed / 4 skipped / 0 OpenRouter boots.
- New offline tests: reasoning-ladder.test.ts (6) asserts default top rung is
  "high" not "xhigh", per-call "off"⇒[null], medium/low/xhigh ladders;
  ensemble-limits.test.ts updated to min-semantics (catalog clamped to calibrated
  ceiling; the A3 65K-for-off-table-models case now clamps to 32K).
- Manual code-read of the 4 call paths: scout (own fetch, no reasoning, clean);
  judge/security_scan (own fetch, no reasoning, clean — calibration untouched);
  cluster csRawLlmCall (reasoning:"off" + maxTokens:4096); ensemble/chat/code_task
  (default effort "high" via reasoningLadderForModel, output clamped to 32K).
- Docs: README env-var table + TESTING.md document LLM_EXT_REASONING_EFFORT.

## Net effect on the per-call cost
- Ensemble output ceiling: 65K → 32K (A3 reverted to min-semantics).
- Ensemble reasoning effort: xhigh → high (configurable; dominant token saving).
- cluster_synonyms: xhigh+65K → no-reasoning+4K (the egregious path the user named).
- scout + security_scan: unchanged (already clean; security calibration preserved).
