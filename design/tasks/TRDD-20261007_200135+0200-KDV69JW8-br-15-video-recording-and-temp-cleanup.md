---
trdd-id: KDV69JW8
title: BR-15 Video recording and temp cleanup
column: backburner
status: tasked
created: 2026-10-07T20:01:35+0200
updated: 2026-10-07T20:01:38+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:35+0200
---

# BR-15 Video recording and temp cleanup

## Goal

Record a WebM video with `--record` and remove the temp files on every exit path.

## Approval log

- 2026-10-07T20:01:35+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (`--record` WebM video; temp record dir removed), D11, E100 (owned by BR-04), BR-24 (credentials refused together with recording).

## Depends on

BR-04 (TRDD-45XGJJ1M)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Record WebM into a temp record dir when `--record` is given.
3. Remove the temp dir on every exit path (success, error, abort).

## Acceptance

- [ ] WebM
- [ ] removed on every exit path
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The credentials-with-recording refusal (BR-24).
