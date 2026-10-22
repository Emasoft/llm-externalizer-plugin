---
trdd-id: PCZZCDSR
title: WK-02 benchmark workload-kit.ts
column: backburner
status: tasked
created: 2026-10-07T20:28:36+0200
updated: 2026-10-07T20:28:39+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:28:36+0200
---

# WK-02 benchmark workload-kit.ts

## Goal
Create `benchmark/workload-kit.ts` holding the helpers duplicated md5-identically across the 6 workloads, as composable steps.

## Approval log

- 2026-10-07T20:28:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (workload-kit row), §16 (WK table), D16.

## Depends on

WK-01 (TRDD-IYL8GCAR)

## Files

- `benchmark/workload-kit.ts` (new); its test file and vitest include entry to be listed at card start.

## Reuse

Read the code at card start (the 6 workloads' duplicated helpers; `benchmark/pick.ts:165`).

## Steps

1. Identify the md5-identical helpers across the 6 workloads (§11).
2. Extract them as composable steps in this order: key, dataset/fingerprint, catalog, pool, gates, ledger, cached per-model loop, `selectSameOrCheaper`, report (§11 sequence; composition shape derived from done-when).
3. Keep WK-01 tests green throughout (derived from done-when).

## Acceptance

- [ ] composable steps of §11
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Migrating any workload (WK-03 to WK-08).
