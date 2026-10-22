---
trdd-id: 7YYSPLX0
title: BR-07 Step payload and trim rule
column: backburner
status: tasked
created: 2026-10-07T20:01:07+0200
updated: 2026-10-07T20:01:10+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:07+0200
---

# BR-07 Step payload and trim rule

## Goal

Build the step payload so it fits one request, trimming with a flagged rule when it does not.

## Approval log

- 2026-10-07T20:01:07+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§5 table row "browse step" (maxRequests 1; overflow goes to the trim rule of BR-07), §10 (catalog spec `browse-step`; scaled validation policy, a step choice has up to 244 options), E95 (owned by SP-21).

## Depends on

BR-06 (TRDD-OZ0EX1CN), SP-20 (TRDD-XRB5PMEN)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start); the spec lives in SP-20.

## Reuse

Planner limits (`ModelLimits`, plan §3 L2); read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Build the step state from the page text and the pruned elements (page text goes in state).
3. When the payload would pass one request, trim by one stated rule and flag the trim in the result.

## Acceptance

- [ ] fits one request
- [ ] trim flagged
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The `browse-step` spec (SP-20), the dropdown trim (SP-21).
