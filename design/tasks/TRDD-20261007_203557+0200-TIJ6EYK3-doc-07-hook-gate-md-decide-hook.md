---
trdd-id: TIJ6EYK3
title: DOC-07 hook-gate.md (decide --hook)
column: backburner
status: tasked
created: 2026-10-07T20:35:57+0200
updated: 2026-10-07T20:36:03+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:35:57+0200
---

# DOC-07 hook-gate.md (decide --hook)

## Goal
The classify skill's `references/hook-gate.md` describing `classify decide --hook`.

## Approval log

- 2026-10-07T20:35:57+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-07); §16 card template and definition of done; §17; D1, D27

## Depends on

C4-05 (TRDD-ZBMRKOI3)

## Files

`skills/llm-externalizer-classify/references/hook-gate.md`.

## Reuse

read the code at card start

## Steps

1. Document `classify decide --hook`, including that it defers (empty stdout, exit 0, stderr notice) when it cannot decide (D1) (derived from title).

## Acceptance

- [ ] (derived from title) hook-gate.md exists and matches C4-05's behaviour
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

The command itself (C4-05).
