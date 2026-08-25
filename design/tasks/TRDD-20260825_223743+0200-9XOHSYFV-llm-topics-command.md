---
trdd-id: 9XOHSYFV
title: llm topics — keyword/keyphrase and language extraction command
column: dev
created: 2026-08-25T22:37:43+0200
updated: 2026-08-25T22:37:43+0200
current-owner: llm-externalizer-session
task-type: feature
min-approval-requirement: none
relevant-rules: []
---

# TRDD-9XOHSYFV — `llm-ext llm topics`

User order (2026-08-25, verbatim intent): add a `topics` command — "will
generate keywords and keyphrases from the input text describing the topics and
the themes/arguments found in the text, including the language".

## Design

- New tool `topics` in the flat catalog; grouped action
  `llm-ext llm topics <input> [--max_keywords N] [--max_keyphrases N]`.
- Core in `src/text-tools/core.ts` (shared with TRDD-VFXS2ZYY /
  TRDD-SYEH38AV / TRDD-Q3ERXAAO), injected LLM seam.
- Output contract: strict JSON `{"language": "<ISO 639-1 or name>",
  "keywords": [..], "keyphrases": [..]}` — parsed and validated; parse
  failure ⇒ ONE corrective retry ⇒ FAILED. Report saves both the JSON and a
  readable rendering.
- Response gate applies (empty/echo ⇒ failure).

## Acceptance

- [ ] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
- [ ] Hermetic unit tests: happy path, JSON repair/retry, parse fail, gate.
- [ ] Benchmark: golden dataset (real multi-language texts with hand-labeled
      expected topic sets incl. language) + mechanical scorer (language match
      + keyword/keyphrase P/R with normalization + synonym-acceptance sets) +
      in-process runner; registry `benchmark` pointer.
- [ ] Registry descriptor (structured_output required).
- [ ] Docs + doc-consistency green.
- [ ] Build + tests + lint green; dogfood; publish.

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-25T22:37:43+0200 | created → dev | User-ordered; batch of 4 text tools sharing one core module. |
