---
trdd-id: VN6KKM2U
title: DOC-04 commands.md
column: backburner
status: tasked
created: 2026-10-07T20:35:46+0200
updated: 2026-10-07T20:35:49+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:35:46+0200
---

# DOC-04 commands.md

## Goal
The classify skill's `references/commands.md` with a flags table that matches the catalog.

## Approval log

- 2026-10-07T20:35:46+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-04); §16 card template and definition of done; §17

## Depends on

C4-11 (TRDD-NYEA7BR3)

## Files

`skills/llm-externalizer-classify/references/commands.md`.

## Reuse

read the code at card start

## Steps

1. Write the flags table for every classify command from the catalog (§13: flags table checked against the catalog).
2. Run DOC-13's check against it.

## Acceptance

- [ ] flags checked by DOC-13
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

The check itself (DOC-13).
