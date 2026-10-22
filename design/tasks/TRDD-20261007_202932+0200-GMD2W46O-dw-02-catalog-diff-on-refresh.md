---
trdd-id: GMD2W46O
title: DW-02 Catalog diff on refresh
column: backburner
status: tasked
created: 2026-10-07T20:29:32+0200
updated: 2026-10-07T20:29:35+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:32+0200
---

# DW-02 Catalog diff on refresh

## Goal
On each decisions-catalog refresh, diff `canonical_slug`, `alias_target`, price and presence, and append the new events.

## Approval log

- 2026-10-07T20:29:32+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (snapshot-drift watcher row), §16 (DW table), D24, E104.

## Depends on

DW-01 (TRDD-RU53X0ZR), L0-07 (TRDD-CASL940C)

## Files

- To be listed at card start.

## Reuse

The DW-01 event kinds; L0-07 catalog refresh. Read the code at card start.

## Steps

1. Hook the diff into the catalog refresh (§11).
2. Compare `canonical_slug`, `alias_target`, price, presence and append `ModelEventKind` events (§11).
3. Make a repeated identical change produce one event (E104).

## Acceptance

- [ ] E104: same alias change seen twice → one event (idempotent)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Rerunning evaluations (DW-03).
