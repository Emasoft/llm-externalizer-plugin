---
trdd-id: UPZR8PAY
title: L1-09 Usage and cost record
column: complete
status: archived
created: 2026-10-07T19:21:18+0200
updated: 2026-10-09T23:30:10+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:18+0200
implementation-commits: [7a2bda5c]
---

# L1-09 Usage and cost record

## Goal
Record usage and cost for every decisions reply before answer validation, estimating cost when the reply has none.

## Approval log

- 2026-10-07T19:21:18+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:30:10+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:10+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:10+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l1/usage.ts`), §7 (Response: usage and cost recorded before validation), D8; E12.

## Depends on

L0-05 (TRDD-OSIGZK0O)

## Files

- `scripts/llm-ext/src/classifiers/l1/usage.ts`
- `scripts/llm-ext/src/classifiers/l1/usage.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`recordRequest` and `withUsageContext` (named in §3; read the code for locations at card start).

## Steps

1. Record usage and cost from the raw reply before any answer validation, so invalid but billed replies are counted (§7).
2. When `usage.cost` is missing, compute tokens × catalog price and set `cost_estimated: true` (D8, E12).
3. Use `recordRequest` and `withUsageContext`, no second usage store (§3, §4 row "Usage/cost record"). (derived from done-when)

## Acceptance

- [x] recorded before validation
- [x] estimate with flag
- [x] E12: `usage.cost` missing → estimated, `cost_estimated: true` (D8)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 7a2bda5c — l1/usage.ts, 8 tests over recorded replies; missing cost computed and marked cost_estimated (D8). Whole package, run by the coordinator on the committed tree: npm test 215 files passed / 4 skipped, 3414 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet, build 0 per the integration worker; the real settings.yaml hash unchanged.

## Out of scope

Parsing the reply (L0-05), usage-history endpoint field (L1-10).
