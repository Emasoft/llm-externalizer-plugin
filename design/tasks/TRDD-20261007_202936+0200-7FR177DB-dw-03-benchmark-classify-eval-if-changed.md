---
trdd-id: 7FR177DB
title: DW-03 benchmark classify-eval --if-changed
column: backburner
status: tasked
created: 2026-10-07T20:29:36+0200
updated: 2026-10-07T20:29:38+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:36+0200
---

# DW-03 benchmark classify-eval --if-changed

## Goal
Add `--if-changed` so `classify-eval` reruns only when a drift event is newer than the last run.

## Approval log

- 2026-10-07T20:29:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (snapshot-drift watcher row), §16 (DW table), D3, D12, D24.

## Depends on

DW-02 (TRDD-GMD2W46O), EV-08 (TRDD-E1KU67RT)

## Files

- To be listed at card start.

## Reuse

The DW-02 events and the EV-06 ledger. Read the code at card start.

## Steps

1. Compare the newest drift event's time with the last ledger run (derived from done-when).
2. If none is newer, print "no change" and exit at $0 (done-when).
3. Otherwise run the EV-08 evaluation, which spends Jev credit with no cap and prints its cost (D2, D12).

## Acceptance

- [ ] reruns only when a drift event is newer than the last run; otherwise prints "no change" at $0
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Producing events (DW-02), the base command (EV-08).
