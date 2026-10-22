---
trdd-id: GLQJZRTE
title: BR-11 Search keyword fallback
column: backburner
status: tasked
created: 2026-10-07T20:01:20+0200
updated: 2026-10-07T20:01:22+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:20+0200
---

# BR-11 Search keyword fallback

## Goal

When the typing model fails on a search field, fall back to a keyword query and report it as degraded.

## Approval log

- 2026-10-07T20:01:20+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

D1 (`browse run` search fields fall back to a keyword query: `degraded`, warning, `fallback` field), §10 (`JUNK_NAMES` and fallback), E96.

## Depends on

BR-10 (TRDD-FH0BQUZZ)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

`l2/warnings.ts` degraded records (plan §3); read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. On typing-model failure for a search field, type a keyword query.
3. Mark the result `degraded`, add a warning and set the `fallback` field (D1).

## Acceptance

- [ ] E96: typing model fails on a search field → keyword fallback, `degraded` (D1)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The typing call (BR-10).
