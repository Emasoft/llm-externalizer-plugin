---
trdd-id: Z55FYUQH
title: Line-index mode of the regex worker for test-output
column: complete
status: archived
created: 2026-10-10T05:29:01+0200
updated: 2026-10-10T09:14:41+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T05:29:01+0200
implementation-commits: [e99d37c5]
---

# Line-index mode of the regex worker for test-output

## Goal

Give the regex worker (SP-22, classifiers/l2/regex-worker.ts) a mode that reports line positions (1-based, strictly ascending line numbers of the matching lines over the whole log, the shape test-output.ts accepts as matches), not only deduplicated matched strings, so SP-17 test-output can use it.

## Plan refs

SP-17 (TRDD-O5NUD6IT), SP-22 (TRDD-DTDGVXWV, complete, commit 0db9627e: returns deduplicated strings, no positions).

## Depends on

SP-22 (TRDD-DTDGVXWV, complete)

## Out of scope

The test-output spec itself (TRDD-O5NUD6IT), the runner prepare step (TRDD-XZZ2NSWY).

## Approval log

- 2026-10-10T05:29:01+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T09:14:41+0200 — COMPLETE by main-agent@llm-externalizer-plugin. e99d37c5 landed; every acceptance box proven by named tests with no test doubles.

## Acceptance

- [x] the regex worker can return 1-based line numbers of matches over a text, under the same deadlines and caps (test)
- [x] a test-output test feeds those line numbers as `matches` (test-output.ts accepts a `matches` array of 1-based line numbers)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

Why: plan §9 classify test-output (plan line 291) and E74; test-output.ts lines 11 and 26: a caller's own pattern is never run in-process, the caller passes matching line numbers found in the regex worker. Without this card test-output still works with its built-in pattern; only the caller-pattern mode needs it.
2026-10-10T09:14:31+0200 e99d37c5: runRegexLines returns 1-based ascending matching line numbers, in the same worker, deadlines, caps, budget and abort path as string mode. Box 1: the 8 'runRegexLines' tests (real threads); the start deadline has no line-mode test because a worker that never comes online cannot be produced with a real thread, and the path is shared with string mode. Box 2: 3 tests in test-output.test.ts feed the numbers straight into the schema and project step. Box 3: the commit gate ran build, tsc, eslint . --quiet, the full suite (4843 passed), and the 11 tests by name; these tests use no test doubles. Cosmetic leftover: a double blank line before runRegexLines in regex-worker.ts, to fix when the file is next touched.
