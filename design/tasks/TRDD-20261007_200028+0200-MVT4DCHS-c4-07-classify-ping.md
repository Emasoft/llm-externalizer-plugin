---
trdd-id: MVT4DCHS
title: C4-07 classify ping
column: backburner
status: tasked
created: 2026-10-07T20:00:28+0200
updated: 2026-10-07T20:00:31+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:28+0200
---

# C4-07 classify ping

## Goal

`classify ping`: a free key check plus one noul call, with `--no-call` to skip the call.

## Approval log

- 2026-10-07T20:00:28+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§9 row `classify ping` (free `GET /api/v1/key` + one noul, or `--no-call`; attention: failure; injection n/a), §3 L4 (`classifiers/commands/ping.ts`).

## Depends on

C4-01 (TRDD-BUL4EEBP)

## Files

`scripts/llm-ext/src/classifiers/commands/ping.ts` (create); test file and vitest include entry: to be listed at card start.

## Reuse

Read the code at card start.

## Steps

1. Call `GET /api/v1/key` (free) through the L0 transport (derived from done-when).
2. Send one noul question unless `--no-call` is given.
3. Any failure is reported and exits non-zero (derived from §9 attention).

## Acceptance

- [ ] free key check
- [ ] one noul
- [ ] `--no-call`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The generic runner (C4-01), `--estimate` (C4-08).
