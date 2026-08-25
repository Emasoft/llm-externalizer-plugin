---
trdd-id: VFXS2ZYY
title: llm summarize — size-bounded text summarization command
column: dev
created: 2026-08-25T22:37:43+0200
updated: 2026-08-25T22:37:43+0200
current-owner: llm-externalizer-session
task-type: feature
min-approval-requirement: none
relevant-rules: []
---

# TRDD-VFXS2ZYY — `llm-ext llm summarize`

User order (2026-08-25, verbatim intent): add a `summarize` command — "will ask
the model to summarize the input text, with the summary size in max chars
specified".

## Design

- New tool `summarize` in the flat catalog (`src/tools/definitions.ts`),
  grouped action `llm-ext llm summarize <input> --max_chars N`.
- Core in `src/text-tools/core.ts` (shared module for the 4 text tools of this
  batch — see TRDD-9XOHSYFV, TRDD-SYEH38AV, TRDD-Q3ERXAAO), injected deps
  (`ensembleStreaming`, `saveResponse`, gate) mirroring `code-task/core.ts` so
  it is hermetically testable and benchmark-drivable in-process.
- Params: `input_file` (positional) OR `input_content` (inline); `max_chars`
  (number, default 1000); optional `language` (output language; default: same
  as input).
- Length contract enforced mechanically: if the response exceeds `max_chars`,
  ONE corrective retry with a stern instruction; still over ⇒ FAILED (fail-fast,
  no silent truncation).
- Response gate (TRDD-P4ULUV1R) applies: empty/echoed responses are failures.
- Output via `saveResponse` (report path on stdout), repo convention.

## Acceptance

- [ ] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
- [ ] Hermetic unit tests (fake LLM seam): happy path, over-length retry,
      over-length fail, echo gate, missing input.
- [ ] Benchmark: hand-curated golden dataset (real texts) + mechanical scorer
      (max-chars compliance + must-mention keyword recall + echo rejection) +
      in-process runner driving the REAL core; registry `benchmark` pointer.
- [ ] Registry descriptor in `model-qualification/registry.ts`.
- [ ] Docs: README counts + tables, rules/use-llm-externalizer.md;
      doc-consistency test green.
- [ ] Build + full test suite + lint green; dogfood; publish.

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-25T22:37:43+0200 | created → dev | User-ordered; batch of 4 text tools sharing one core module. |
