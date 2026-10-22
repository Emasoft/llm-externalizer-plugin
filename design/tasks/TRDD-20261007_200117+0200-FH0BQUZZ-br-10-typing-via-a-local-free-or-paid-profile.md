---
trdd-id: FH0BQUZZ
title: BR-10 Typing via a local, free or paid profile
column: backburner
status: tasked
created: 2026-10-07T20:01:17+0200
updated: 2026-10-07T20:01:19+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:17+0200
---

# BR-10 Typing via a local, free or paid profile

## Goal

Type text through `--typing-profile`, accepting only local, free or paid profiles.

## Approval log

- 2026-10-07T20:01:17+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 Typing (the normal `--typing-profile`, default `active:`, through the existing chat chain; 256 tokens, reasoning off), PF-05 (`browse run --typing-profile` accepts local/free/paid; decisions profile accepts only `classifier`), D37.

## Depends on

BR-09 (TRDD-E2RBNJGG), PF-05 (TRDD-LMS3JT0C)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

The existing chat chain (read the code at card start).

## Steps

1. Resolve `--typing-profile` (default `active:`) and refuse a scouting or classifier type (PF-05).
2. Call the existing chat chain with 256 tokens and reasoning off.
3. Add the typing cost to the run's cost, printed with the Jev cost (§10).

## Acceptance

- [ ] 256 tokens, reasoning off
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Keyword fallback (BR-11), profile acceptance rows (PF-05).
