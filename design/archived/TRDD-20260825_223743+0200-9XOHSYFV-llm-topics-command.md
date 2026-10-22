---
trdd-id: 9XOHSYFV
title: llm topics — keyword/keyphrase and language extraction command
column: complete
created: 2026-08-25T22:37:43+0200
updated: 2026-08-27T15:18:22+0200
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

- [x] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
      `tools/definitions.ts:1508`, `index.ts:3550`, `cli/main.ts:418`,
      `cli/launcher.ts:51`, `estimate.ts:150`.
- [x] Hermetic unit tests: happy path, JSON repair/retry, parse fail, gate.
      `src/text-tools/core.test.ts`, registered `vitest.config.ts:22`, 29
      tests, all executing (verified by running that file alone, not inferred
      from the aggregate suite total). The `gate` case was MISSING at first
      closure and was written on 2026-08-27 — see the status log.
- [x] Benchmark: golden dataset (real multi-language texts with hand-labeled
      expected topic sets incl. language) + mechanical scorer (language match
      + keyword/keyphrase P/R with normalization + synonym-acceptance sets) +
      in-process runner; registry `benchmark` pointer.
      `benchmark/text-tools/dataset.ts:154` (TOPICS_CASES),
      `score.ts:84`, `bench-runner.ts:325`.
- [x] Registry descriptor (structured_output required).
      `model-qualification/registry.ts:153`.
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
| 2026-08-27T15:10:01+0200 | complete (stays) | **Box 2's `gate` case was ticked unmet** — caught by adversarial review. `gateLLMResponse` is wired in the shared retry loop (`text-tools/core.ts:417`) but nothing fed it an empty or echoed response; `response-gate.surfaces.test.ts` covers chat/code_task/check_imports and never the text tools. Written rather than un-ticked. Also recorded: `structured_output required` in box 4 holds only INDIRECTLY — this descriptor passes `criteria({ requireReasoning: false })`, which inherits `DEFAULT_CRITERIA` (structured + reasoning, `registry.ts:59-62`); the string `structured_output` appears nowhere in `registry.ts`, so a grep for it returns nothing and proves nothing either way. Suite 2194 → 2197. |
| 2026-08-27T15:18:22+0200 | complete (stays) | Two proxies replaced with measurements. (1) Box 4's `structured_output required` was argued from a COMMENT at `registry.ts:59-62` describing what `DEFAULT_CRITERIA` is — the same characterise-an-unread-mechanism move this project retracted three times on TRDD-V32LB992. Opened the definition: `benchmark/discover.ts:97` sets `requireStructuredOutputs: true`, and this descriptor overrides only `requireReasoning`, so it inherits it. Box holds, now on the value rather than its description. (2) Box 1 verified behaviourally with `llm-ext llm --help` off PATH — all four group rows present in the installed 13.6.0 bundle. |
