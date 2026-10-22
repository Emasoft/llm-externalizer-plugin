---
trdd-id: OC18PZ4V
title: L1-06 Answer-set validation
column: complete
status: archived
created: 2026-10-07T19:21:00+0200
updated: 2026-10-10T03:06:33+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:00+0200
implementation-commits: [6fbc2176, f651b119, da2da099]
---

# L1-06 Answer-set validation

## Goal
Validate a whole reply: missing, extra and wrongly typed answers.

## Approval log

- 2026-10-07T19:21:00+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:06:13+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:06:13+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:06:33+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§6 (answer-set rule), §2b (OpenRouterTeam/skills: its `lib.ts` strictness as validation baseline); E27.

## Depends on

L1-04 (TRDD-7W3JFF7V), L1-05 (TRDD-NB7JXJGF)

## Files

- `scripts/llm-ext/src/classifiers/l1/validate.ts`
- `scripts/llm-ext/src/classifiers/l1/validate.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. A missing answer makes only that question invalid (E27).
2. An extra answer key is ignored and logged (§6).
3. An explicit wrong `type` makes the answer invalid; an absent `type` is accepted (§6).
4. Compare the strictness against the `lib.ts` baseline named in §2b. (derived from done-when)

## Acceptance

- [x] missing rule
- [x] extra rule
- [x] type rule
- [x] E27: One answer missing in a multi-question reply → only that item invalid
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 6fbc2176 (code, tests, fixture), f651b119 (test include list), da2da099 (rebuilt dist) — l1/validate-answers.ts validateAnswers(questions, reply, policy) returns {answers, extra}: a missing answer makes only that question invalid (E27), extra keys are ignored and returned in extra for the caller to log (no logger exists in src/classifiers), an explicit wrong type is invalid and an absent type is accepted (per-type validators reused, not edited); l1/validate-answers.test.ts; a real multi-answer reply was captured as fixture __fixtures__/p01/dec-multi3.json (noul + choice + score, 3 Valid answers). Reference comparison done against OpenRouterTeam/skills lib.ts @ 33597a4 (14 cases): ours is looser by plan on extra answers, absent type and score legend (ignored); out-of-range confidence is dropped under the default policy and rejected under the strict one; a choice whose probabilities omit an option key is not checked (validateScore does check this) and is a candidate decision. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. Deviations: the code is in l1/validate-answers.ts, not validate.ts as the Files list says; extra keys are returned, not logged. OPEN ITEMS: none blocking; choice probabilities missing an option key is looser than the reference.

## Out of scope

Per-question validation (L1-03 to L1-05), chunk merging (L2-19).
