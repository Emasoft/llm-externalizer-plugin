---
trdd-id: VFXS2ZYY
title: llm summarize — size-bounded text summarization command
column: complete
created: 2026-08-25T22:37:43+0200
updated: 2026-08-27T15:18:22+0200
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

- [x] Tool in catalog + dispatch + `llm` group row + PROFILE_AWARE_TOOLS.
      `tools/definitions.ts:1476`, `index.ts:3549`, `cli/main.ts:417`,
      `cli/launcher.ts:50`, `estimate.ts:149`.
- [x] Hermetic unit tests (fake LLM seam): happy path, over-length retry,
      over-length fail, echo gate, missing input. `src/text-tools/core.test.ts`,
      registered `vitest.config.ts:22`, 29 tests, all executing (verified by
      running that file alone, not inferred from the aggregate suite total).
      The `echo gate` case was MISSING at first closure and was written on
      2026-08-27 — see the status log.
- [x] Benchmark: hand-curated golden dataset (real texts) + mechanical scorer
      (max-chars compliance + must-mention keyword recall + echo rejection) +
      in-process runner driving the REAL core; registry `benchmark` pointer.
      `benchmark/text-tools/dataset.ts:26` (SUMMARIZE_CASES), `score.ts:58`,
      `bench-runner.ts:307`, `text-tools/index.ts:706`.
- [x] Registry descriptor in `model-qualification/registry.ts` — line 145.
- [x] Docs: README counts + tables, rules/use-llm-externalizer.md;
      doc-consistency test green.
- [x] Build + full test suite + lint green; dogfood; publish.
      Verified at HEAD 436dfe0 on 2026-08-27: build exit 0, 2194 tests passed
      (4 skipped), eslint --max-warnings 0 exit 0, dogfood 108 PASS / 0 FAIL,
      released as v13.6.0.

## Status log

| Date | Status change | Note |
|---|---|---|
| 2026-08-25T22:37:43+0200 | created → dev | User-ordered; batch of 4 text tools sharing one core module. |
| 2026-08-27T14:57:11+0200 | dev → complete | Shipped in v13.6.0 (2026-08-26); card was left open. Every acceptance box re-verified first-hand at HEAD 436dfe0 before closing. |
| 2026-08-27T15:10:01+0200 | complete (stays) | **Box 2's `echo gate` case was ticked unmet** — caught by adversarial review. This card names the gate most explicitly of the four (§Design cites TRDD-P4ULUV1R) and it was still the missing case: `gateLLMResponse` is wired at `text-tools/core.ts:417` but nothing exercised it, and `response-gate.surfaces.test.ts` covers chat/code_task/check_imports only. Both verdicts now tested on the shared loop — empty (2 calls, then FAILED) and echo — asserting the exact user-facing strings from `gateFailureMessage`, so a reworded message cannot silently pass. Written rather than un-ticked; the shipped code was already correct. Suite 2194 → 2197. |
| 2026-08-27T15:18:22+0200 | complete (stays) | The two gate tests were shown to CONSTRAIN, and the blast radius corrected. Mutation: killed the gate's consumption at `text-tools/core.ts:418` (`if (false && verdict !== null)`), leaving `gateLLMResponse` itself running so only the branch was modelled away. Both gate tests died with the right reason — `expected undefined to be true` on `result.isError`, i.e. an empty/echoed answer sailing through as success — not an incidental call-count mismatch. Correction to a claim made earlier today: "nothing else depends on the gate" was drawn from running ONE file. Under the full suite the mutant kills **4 tests in 2 files** — `text-tools/core.test.ts` and `benchmark/text-tools/bench-runner.test.ts` — so the benchmark runner also constrains this behaviour. The narrow claim was a 29-test sample reported as a 2197-test property. |
