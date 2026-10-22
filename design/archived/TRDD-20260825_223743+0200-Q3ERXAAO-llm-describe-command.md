---
trdd-id: Q3ERXAAO
title: llm describe — concise file nature/intent/usage description command
column: complete
created: 2026-08-25T22:37:43+0200
updated: 2026-08-27T15:18:22+0200
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

- [x] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
      `tools/definitions.ts:1568`, `index.ts:3552`, `cli/main.ts:420`,
      `cli/launcher.ts:53`, `estimate.ts:152`.
- [x] Hermetic unit tests: happy path per input kind, over-length retry/fail,
      gate, missing file. `src/text-tools/core.test.ts`, registered
      `vitest.config.ts:22`, 29 tests, all executing (verified by running that
      file alone, not inferred from the aggregate suite total). The happy-path
      and `gate` cases were MISSING at first closure and were written on
      2026-08-27 — see the status log. Coverage is honestly ONE file kind
      (.css), not "per input kind"; the six kinds are covered by the benchmark
      corpus below, which is a different instrument.
- [x] Benchmark: golden dataset of REAL small files of diverse kinds (prompt
      .md, .csv, .json config, .css, code) with hand-labeled must-mention
      concept sets (synonym-tolerant) + mechanical scorer (concept recall +
      max-chars compliance + echo rejection) + in-process runner; registry
      pointer. `benchmark/text-tools/dataset.ts:368` (DESCRIBE_CASES),
      `score.ts:161`, `bench-runner.ts`, `text-tools/index.ts:724`.
- [x] Registry descriptor. `model-qualification/registry.ts:168`.
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
| 2026-08-27T15:10:01+0200 | complete (stays) | **Box 2 was ticked unmet** — caught by adversarial review. `runDescribe` had exactly ONE test (missing-file); no happy path, and no `gate` case despite the box naming one. I had read the 26 test titles and still ticked, because I checked that the test FILE existed and was registered rather than what it asserted — registration is not execution and execution is not coverage. Both cases written rather than un-ticked (the shipped code was correct; only the promised coverage was absent): a real-file happy path asserting the filename reaches the prompt — the hint that lets describe tell a .css from a .csv — and the shared-loop gate cases. Suite 2194 → 2197. The box's "per input kind" is still overstated and is now qualified in place rather than quietly re-scoped. |
| 2026-08-27T15:18:22+0200 | complete (stays) | The new happy-path test was shown to CONSTRAIN, not merely pass — and it had been exempted from that standard one sentence after I articulated it, on an argument ("asserts specific values, so it cannot pass vacuously") rather than a measurement. Mutation: replaced `basename(file)` with a literal at `text-tools/core.ts:622`, so the filename never reaches the prompt. Exactly one test died, with the right reason — `expected 'The fenced content below is the file …' to contain 'theme.css'` — confirming the test guards the filename hint the card calls load-bearing, and nothing else was relying on it. `core.ts` restored and byte-compared against a pre-mutation copy, not just `git status`. Box 1 also verified behaviourally via `llm-ext llm --help` off PATH. |
