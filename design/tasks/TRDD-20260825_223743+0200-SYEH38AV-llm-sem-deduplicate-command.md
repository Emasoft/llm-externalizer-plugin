---
trdd-id: SYEH38AV
title: llm sem-deduplicate — semantic deduplication of phrase lists
column: dev
created: 2026-08-25T22:37:43+0200
updated: 2026-08-25T22:37:43+0200
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

- [ ] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
- [ ] Hermetic unit tests: literal pre-dedup, subset validation, retry, fail,
      gate, JSON/lines/comma input forms.
- [ ] Benchmark: golden dataset of phrase lists with hand-labeled meaning
      clusters + mechanical scorer (exactly one survivor per cluster; pairwise
      duplicate-detection P/R/F1) + in-process runner; registry pointer.
- [ ] Registry descriptor (structured_output required).
- [ ] Docs + doc-consistency green.
- [ ] Build + tests + lint green; dogfood; publish.

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-25T22:37:43+0200 | created → dev | User-ordered; batch of 4 text tools sharing one core module. |
