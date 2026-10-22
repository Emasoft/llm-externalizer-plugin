---
trdd-id: MJP5R1K9
title: BR-16 Stuck detection
column: backburner
status: tasked
created: 2026-10-07T20:01:38+0200
updated: 2026-10-07T20:01:41+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:38+0200
---

# BR-16 Stuck detection

## Goal

End with status `stuck` when the page has no actionable elements or the same action repeats.

## Approval log

- 2026-10-07T20:01:38+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (status `stuck`; stuck noul), E91, E92.

## Depends on

BR-08 (TRDD-5D4X8KFN)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. A page with no actionable elements ends as `stuck`.
3. The same action repeated N times ends as `stuck` (N as the source defines it).

## Acceptance

- [ ] E91: page with no actionable elements → `stuck`
- [ ] E92: same action repeated N times → `stuck`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

No-op recovery (BR-25).
