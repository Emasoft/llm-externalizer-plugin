---
trdd-id: SYEH38AV
title: llm sem-deduplicate — semantic deduplication of phrase lists
column: complete
created: 2026-08-25T22:37:43+0200
updated: 2026-08-27T15:18:22+0200
current-owner: llm-externalizer-session
task-type: feature
min-approval-requirement: none
relevant-rules: []
---

# TRDD-SYEH38AV — `llm-ext llm sem-deduplicate`

User order (2026-08-25, verbatim intent): deduplicate a set/list of phrases
SEMANTICALLY, not literally ("`computer programming` and `coding` are the same
thing semantically, or `rasterize` and `render to image` or `render to
bitmap`"). The LLM must pick the best representative of each meaning group and
return a list devoid of same-meaning duplicates.

## Design

- New tool `sem_deduplicate` in the flat catalog; grouped action
  `llm-ext llm sem-deduplicate <input>`.
- Input: file with one phrase per line (or inline content; JSON array also
  accepted). Literal dedup (case/whitespace-insensitive) done in code FIRST —
  no LLM tokens wasted on exact duplicates (the user's own observation).
- Core in `src/text-tools/core.ts`, injected LLM seam.
- Output contract: strict JSON array of surviving phrases. HARD mechanical
  validation: every output entry MUST be one of the input phrases (verbatim
  after trim) — a hallucinated/reworded entry ⇒ ONE corrective retry ⇒ FAILED.
  Survivor count must be ≤ input count and ≥ 1.
- Related prior art: `cluster_synonyms` (heavyweight 3-phase pipeline for
  10k+ corpora). This tool is the LIGHT single-call path for small lists —
  deliberate scope split; do not merge them.

## Acceptance

- [x] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
      Catalog/dispatch under the internal name `sem_deduplicate`; the CLI
      spelling is `sem-deduplicate` (`cli/launcher.ts:52` maps one to the
      other). Catalog `tools/definitions.ts:1538`, dispatch `index.ts:3551`
      and `:3574`, `cli/main.ts:419`, `estimate.ts:158`.
- [x] Hermetic unit tests: literal pre-dedup, subset validation, retry, fail,
      gate, JSON/lines/comma input forms. `src/text-tools/core.test.ts`,
      registered `vitest.config.ts:22`, 29 tests, all executing (verified by
      running that file alone, not inferred from the aggregate suite total).
      The `gate` case was MISSING at first closure and was written on
      2026-08-27 — see the status log.
- [x] Benchmark: golden dataset of phrase lists with hand-labeled meaning
      clusters + mechanical scorer (exactly one survivor per cluster; pairwise
      duplicate-detection P/R/F1) + in-process runner; registry pointer.
      `benchmark/text-tools/dataset.ts:287` (SEM_DEDUP_CASES),
      `score.ts:128`, `bench-runner.ts:70`.
- [x] Registry descriptor (structured_output required).
      `model-qualification/registry.ts:160`.
- [x] Docs + doc-consistency green. `docs/tool-use-cases.md`,
      `docs/agent-usage-reference.md`, README; `doc-consistency.test.ts` green.
- [x] Build + tests + lint green; dogfood; publish.
      Verified at HEAD 436dfe0 on 2026-08-27: build exit 0, 2194 tests passed
      (4 skipped), eslint --max-warnings 0 exit 0, dogfood 108 PASS / 0 FAIL,
      released as v13.6.0.

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-25T22:37:43+0200 | created → dev | User-ordered; batch of 4 text tools sharing one core module. |
| 2026-08-27T14:57:11+0200 | dev → complete | Shipped in v13.6.0 (2026-08-26); card was left open. Every acceptance box re-verified first-hand at HEAD 436dfe0 before closing. |
| 2026-08-27T15:10:01+0200 | complete (stays) | **Box 1's evidence was invalid and box 2 was ticked unmet.** An adversarial review caught both. (1) The grep that "verified" catalog+dispatch matched `sem-deduplicate` with a HYPHEN; the internal symbol is `sem_deduplicate`, so it could not match and returned nothing for this tool — while I had already written the hyphen/underscore split into this very card and did not turn the instrument around. Re-grepped with the real symbol: the box is TRUE (`definitions.ts:1538`, `index.ts:3551`), so the tick stands, but it stood on nothing until now. (2) Box 2 names a `gate` case that did not exist — `gateLLMResponse` is wired at `text-tools/core.ts:417` but no test fed it an empty or echoed response, and `response-gate.surfaces.test.ts` covers chat/code_task/check_imports only. Written rather than un-ticked, since the code was correct and only the promised coverage was absent. Suite 2194 → 2197. Lesson: a grep proves a SYMBOL absent, never a THING absent — and a name-split you have already documented is the first place a negative result should send you. |
| 2026-08-27T15:18:22+0200 | complete (stays) | Box 1 verified BEHAVIOURALLY, closing the last proxy: every earlier tick — including the corrected one above — rested on source text, while the box asserts a CLI surface, and `cli-verify-on-path.md` requires invoking it. Ran `llm-ext llm --help` off PATH (resolves to the installed 13.6.0 bundle, not this working copy): all four group rows present, `sem-deduplicate -> sem-deduplicate`. Then a real run, `llm-ext llm sem-deduplicate <file>`: it resolved, dispatched, built the prompt, called the pool, and ended `FAILED: response is not a JSON array of strings` after the free model returned empties — the documented fail-fast contract firing, i.e. the whole path executing, not a wiring break. This is the tool whose CLI spelling differs from its symbol, so it is exactly the one where a source-only proof was worth least. |
