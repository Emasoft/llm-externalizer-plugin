---
trdd-id: IH62RWY2
title: SEC-03 Key handling tests
column: backburner
status: tasked
created: 2026-10-07T20:29:52+0200
updated: 2026-10-07T20:30:01+0200
current-owner: user
created-by: user
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:52+0200
---

# SEC-03 Key handling tests

## Goal
Test that the API key comes from the environment only, is never logged, and that the refusal works.

## Approval log

- 2026-10-07T20:29:52+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§16 (SEC table), D31 (key from the environment only).

## Depends on

L0-02 (TRDD-CWQOWEHO)

## Files

- To be listed at card start (test file and vitest include entry).

## Reuse

Read the code at card start (L0-02 key handling).

## Steps

1. Test that the key is read only from the environment (done-when).
2. Test that the key string appears in no stdout, stderr, report or log (done-when).
3. Test the refusal when the key is absent or supplied another way (derived from done-when).

## Acceptance

- [ ] env only, never logged, refusal works
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Key handling implementation (L0-02).
