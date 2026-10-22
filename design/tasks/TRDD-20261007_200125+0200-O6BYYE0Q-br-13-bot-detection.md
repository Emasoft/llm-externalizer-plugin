---
trdd-id: O6BYYE0Q
title: BR-13 Bot detection
column: backburner
status: tasked
created: 2026-10-07T20:01:25+0200
updated: 2026-10-07T20:01:28+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:25+0200
---

# BR-13 Bot detection

## Goal

Detect a Cloudflare bot wall or challenge page and end with status `blocked`.

## Approval log

- 2026-10-07T20:01:25+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (bot detection; status `blocked`), E93, D18 (bot wall is an internal decision reproduced inside `browse run`).

## Depends on

BR-06 (TRDD-OZ0EX1CN)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Detect the bot wall or challenge page after extraction.
3. End the run with status `blocked`.

## Acceptance

- [ ] E93: Cloudflare bot wall / challenge page → `blocked`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Stuck detection (BR-16).
