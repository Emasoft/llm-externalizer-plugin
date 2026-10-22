---
trdd-id: I53HOD1A
title: SEC-06 Browse SSRF tests
column: backburner
status: tasked
created: 2026-10-07T20:30:15+0200
updated: 2026-10-07T20:30:18+0200
current-owner: user
created-by: user
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:30:15+0200
---

# SEC-06 Browse SSRF tests

## Goal
Test that `browse` refuses server-side request forgery targets.

## Approval log

- 2026-10-07T20:30:15+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§16 (SEC table; npt BR-05). The plan gives no done-when.

## Depends on

BR-05 (TRDD-VC3HOSDO)

## Files

- To be listed at card start.

## Reuse

Read the code at card start (BR-05).

## Steps

1. Read BR-05 and list its URL rules (derived from title).
2. Test each refused target class is refused (derived from title).

## Acceptance

- [ ] BR-05's URL refusals hold against SSRF targets (derived from title; the plan gives no done-when)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

BR-05 implementation.
