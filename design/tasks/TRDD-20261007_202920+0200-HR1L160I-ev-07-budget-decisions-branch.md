---
trdd-id: HR1L160I
title: EV-07 Budget decisions branch
column: backburner
status: tasked
created: 2026-10-07T20:29:20+0200
updated: 2026-10-07T20:29:22+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:20+0200
---

# EV-07 Budget decisions branch

## Goal
Teach `BM/budget.ts` `chargeRequest`/`chargeResponse` the decisions shape.

## Approval log

- 2026-10-07T20:29:20+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (budget decisions branch row), §16 (EV table), E103.

## Depends on

none

## Files

- `BM/budget.ts`; its test and vitest include entry to be listed at card start.

## Reuse

Read the code at card start (`chargeRequest`, `chargeResponse`).

## Steps

1. Add a decisions branch: input tokens only, output free, `usage.cost` or estimate (§11).
2. Test with a decisions request and response (derived from E103).

## Acceptance

- [ ] E103: decisions call in benchmark budget → input tokens charged only
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The runner (EV-06), the command (EV-08).
