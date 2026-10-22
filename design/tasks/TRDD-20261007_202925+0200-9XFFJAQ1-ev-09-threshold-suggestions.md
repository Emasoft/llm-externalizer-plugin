---
trdd-id: 9XFFJAQ1
title: EV-09 Threshold suggestions
column: backburner
status: tasked
created: 2026-10-07T20:29:25+0200
updated: 2026-10-07T20:29:28+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:25+0200
---

# EV-09 Threshold suggestions

## Goal
Print suggested thresholds from `classify-eval` results, never writing them anywhere.

## Approval log

- 2026-10-07T20:29:25+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (`classify-eval` row: "suggests thresholds (never writes them)"), §16 (EV table).

## Depends on

EV-08 (TRDD-E1KU67RT)

## Files

- To be listed at card start (suggestion code, its test, vitest include entry).

## Reuse

Read the code at card start.

## Steps

1. Derive suggested threshold values from the metrics (derived from done-when).
2. Print them; make no file or config write (done-when).
3. Test that no file is written (derived from done-when).

## Acceptance

- [ ] printed, never written
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The command itself (EV-08).
