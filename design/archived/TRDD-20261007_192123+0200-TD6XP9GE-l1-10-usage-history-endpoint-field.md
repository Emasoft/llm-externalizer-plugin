---
trdd-id: TD6XP9GE
title: L1-10 Usage-history endpoint field
column: complete
status: archived
created: 2026-10-07T19:21:23+0200
updated: 2026-10-10T00:01:06+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:23+0200
implementation-commits: [0564450f]
---

# L1-10 Usage-history endpoint field

## Goal
Add an endpoint field to usage history so stats and readers show decisions calls, while old entries still read.

## Approval log

- 2026-10-07T19:21:23+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:01:05+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:05+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:06+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l1/usage.ts`), §9 receipt paragraph (lifetime totals go into llm-ext's usage history, L1-10, D31).

## Depends on

L1-09 (TRDD-UPZR8PAY)

## Files

To be listed at card start (the usage-history writer and its readers).

## Reuse

Read the code at card start.

## Steps

1. Read the usage-history writer and every reader (stats and others). (derived from done-when)
2. Add the endpoint field to new entries. (derived from done-when)
3. Stats and readers show decisions calls. (derived from done-when)
4. Entries without the field still read. (derived from done-when)

## Acceptance

- [x] stats/readers show decisions calls
- [x] old entries still read
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 0564450f — src/usage-history.ts (optional 8th field endpoint=<name>; parseHistoryLine, readHistory, countByEndpoint), src/classifiers/l1/usage.ts (recordDecisionsUsage now requires endpoint), with usage-history.test.ts and usage.test.ts (45 tests together; both are extended existing test files, so no new vitest include entry). Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean. OPEN ITEMS: README.md (~1362-1376) and docs/agent-usage-reference.md (~603-628) still describe the 7-field history format (the docs cards own that); a minimal history reader was added because none existed in src, rather than inventing a stats command.

## Out of scope

Recording itself (L1-09), the receipt line (C4-12).
