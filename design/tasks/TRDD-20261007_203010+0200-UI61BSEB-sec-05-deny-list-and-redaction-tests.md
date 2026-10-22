---
trdd-id: UI61BSEB
title: SEC-05 Deny list and redaction tests
column: backburner
status: tasked
created: 2026-10-07T20:30:10+0200
updated: 2026-10-07T20:30:14+0200
current-owner: user
created-by: user
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:30:10+0200
---

# SEC-05 Deny list and redaction tests

## Goal
Test the secret deny list and redaction.

## Approval log

- 2026-10-07T20:30:10+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§2b (secret deny list from claude-jev and quicksilver), §16 (SEC table; npt L2-07). The plan gives no done-when.

## Depends on

L2-07 (TRDD-6NYXR3FE)

## Files

- To be listed at card start.

## Reuse

Read the code at card start (L2-07; L2-15 redaction).

## Steps

1. Test that files on the deny list are never sent (derived from title).
2. Test that registered values are redacted from output (derived from title).

## Acceptance

- [ ] deny-listed files are refused and registered values are redacted (derived from title; the plan gives no done-when)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Deny list and redaction implementation (L2-07, L2-15).
