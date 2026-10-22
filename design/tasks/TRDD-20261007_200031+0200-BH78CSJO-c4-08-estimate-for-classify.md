---
trdd-id: BH78CSJO
title: C4-08 estimate for classify
column: backburner
status: tasked
created: 2026-10-07T20:00:31+0200
updated: 2026-10-07T20:00:33+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:31+0200
---

# C4-08 estimate for classify

## Goal

`--estimate` for classify commands: no call, token count and cost ceiling.

## Approval log

- 2026-10-07T20:00:31+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§3 L1 (`l1/estimate.ts`), D2 (no default cap; every run prints cost), E49 and E87 (owned by L2-11).

## Depends on

C4-01 (TRDD-BUL4EEBP), L2-11 (TRDD-37X07EPM)

## Files

To be listed at card start (flag wiring in the runner; test file and vitest include entry).

## Reuse

`estimateTokens` (plan §3 L1 signature); L2-11 cost cap. Otherwise read the code at card start.

## Steps

1. Add `--estimate` to the runner so it plans the requests and sends none (derived from done-when).
2. Print tokens and the cost ceiling from catalog price (derived from done-when).

## Acceptance

- [ ] no call
- [ ] tokens + cost ceiling
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The `--max-budget` check (L2-11), the receipt (C4-12).
