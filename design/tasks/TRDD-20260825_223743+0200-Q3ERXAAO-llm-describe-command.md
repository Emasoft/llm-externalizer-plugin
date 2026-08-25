---
trdd-id: Q3ERXAAO
title: llm describe — concise file nature/intent/usage description command
column: dev
created: 2026-08-25T22:37:43+0200
updated: 2026-08-25T22:37:43+0200
current-owner: llm-externalizer-session
task-type: feature
min-approval-requirement: none
relevant-rules: []
---

# TRDD-Q3ERXAAO — `llm-ext llm describe`

User order (2026-08-25, verbatim intent): read the input file (code or prose)
and describe concisely its nature, intent, likely usage and scope. Examples:
a prompt .md → what the prompt aims at, scope, intended usage; a .csv → what
the list is made of and for what context; a JSON config → configuration of
what and for what intent; a CSS file → visual intent and effect; a code file →
what the code does and for what intent. Must accept max chars param bounding
the description size.

## Design

- New tool `describe` in the flat catalog; grouped action
  `llm-ext llm describe <file> [--max_chars N]` (default 500).
- Core in `src/text-tools/core.ts` (shared with the other 3), injected seam.
- Prompt carries the filename + extension as a hint plus the content, and asks
  for: nature, intent, likely usage, scope — one compact paragraph, no
  restating of the content.
- Length contract: same as summarize — over `max_chars` ⇒ ONE corrective
  retry ⇒ FAILED. Response gate applies.

## Acceptance

- [ ] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
- [ ] Hermetic unit tests: happy path per input kind, over-length retry/fail,
      gate, missing file.
- [ ] Benchmark: golden dataset of REAL small files of diverse kinds (prompt
      .md, .csv, .json config, .css, code) with hand-labeled must-mention
      concept sets (synonym-tolerant) + mechanical scorer (concept recall +
      max-chars compliance + echo rejection) + in-process runner; registry
      pointer.
- [ ] Registry descriptor.
- [ ] Docs + doc-consistency green.
- [ ] Build + tests + lint green; dogfood; publish.

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-25T22:37:43+0200 | created → dev | User-ordered; batch of 4 text tools sharing one core module. |
