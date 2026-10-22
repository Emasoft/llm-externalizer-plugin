---
trdd-id: FD7H1HZL
title: SEC-04 ReDoS isolation review
column: backburner
status: tasked
created: 2026-10-07T20:30:02+0200
updated: 2026-10-07T20:30:09+0200
current-owner: user
created-by: user
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:30:02+0200
---

# SEC-04 ReDoS isolation review

## Goal
Review that regular expressions run on untrusted input are isolated against ReDoS.

## Approval log

- 2026-10-07T20:30:02+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§16 (SEC table; npt SP-22). The plan gives no further detail.

## Depends on

SP-22 (TRDD-DTDGVXWV)

## Files

- To be listed at card start.

## Reuse

Read the code at card start (SP-22).

## Steps

1. Read SP-22 and list every regex that touches untrusted input (derived from title).
2. Check each is isolated; add a test or fix where it is not (derived from title).

## Acceptance

- [ ] every untrusted-input regex in SP-22 is isolated against ReDoS (derived from title; the plan gives no done-when)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

SP-22 implementation.
