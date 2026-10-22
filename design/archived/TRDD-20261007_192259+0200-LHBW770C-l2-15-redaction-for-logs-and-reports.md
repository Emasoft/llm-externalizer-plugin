---
trdd-id: LHBW770C
title: L2-15 Redaction for logs and reports
column: complete
status: archived
created: 2026-10-07T19:22:59+0200
updated: 2026-10-10T00:01:04+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:59+0200
implementation-commits: [dafba1a4, 0b59bb6a]
---

# L2-15 Redaction for logs and reports

## Goal
Redaction of logs and reports that survives cyclic, deep, Map and class-instance values.

## Approval log

- 2026-10-07T19:22:59+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:04+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:04+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:04+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l2/redact.ts`), §14 row 28 (`redactDeep` gaps: depth, keys, instances); E54.

## Depends on

none

## Files

- `scripts/llm-ext/src/classifiers/l2/redact.ts`
- `scripts/llm-ext/src/classifiers/l2/redact.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Redact registered values and secret-like keys in any value passed to a log or report. (derived from done-when)
2. Handle cycles, deep nesting, Maps and class instances without crashing (E54, §14 row 28).
3. Support registering a value to redact (BR-14 registers the password). (derived from done-when)

## Acceptance

- [x] E54: Cyclic / deep / Map / class-instance values in logs → redacted without crash
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed dafba1a4 and 0b59bb6a (vitest include list) — l2/redact.ts (createRedactor with register and redact, MAX_DEPTH 20, MAX_NODES 10000; reuses redactSecrets), l2/redact.test.ts 22 tests; E54 cyclic, 100000-deep, Map and class-instance values redacted without crash and without mutating the input. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. Output is a redacted copy, not a string; Error stacks are deliberately omitted.

## Out of scope

Content redaction before send (L2-07), password handling (BR-14).
