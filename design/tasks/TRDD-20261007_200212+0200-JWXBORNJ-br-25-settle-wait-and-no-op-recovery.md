---
trdd-id: JWXBORNJ
title: BR-25 Settle wait and no-op recovery
column: backburner
status: tasked
created: 2026-10-07T20:02:12+0200
updated: 2026-10-07T20:02:15+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:02:12+0200
---

# BR-25 Settle wait and no-op recovery

## Goal

Wait for the page to settle between steps and recover from an action with no visible effect.

## Approval log

- 2026-10-07T20:02:12+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (settle/DOM-stability wait between steps; repeat-no-op recovery picks the next-best action from the previous distribution, no extra call), E111.

## Depends on

BR-09 (TRDD-E2RBNJGG)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Wait for DOM stability between steps.
3. When an action had no visible effect, pick the next-best action from the previous distribution, with no extra Jev call.

## Acceptance

- [ ] E111: action had no visible effect → next-best action from the prior distribution
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Stuck detection (BR-16).
