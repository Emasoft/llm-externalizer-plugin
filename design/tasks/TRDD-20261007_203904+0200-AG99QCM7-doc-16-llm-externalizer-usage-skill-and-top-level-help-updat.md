---
trdd-id: AG99QCM7
title: DOC-16 llm-externalizer-usage skill and top-level help updated
column: backburner
status: tasked
created: 2026-10-07T20:39:04+0200
updated: 2026-10-07T20:39:47+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:39:04+0200
---

# DOC-16 llm-externalizer-usage skill and top-level help updated

## Goal
Add the `classify` and `browse` groups, the five profile names and `profile-type` to the usage skill and its references and to the `llm-ext --help` group list.

## Approval log

- 2026-10-07T20:39:04+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-16); §16 card template and definition of done; §17

## Depends on

C4-03 (TRDD-4Q1IVJOE), BR-03 (TRDD-TRDGXSF0), PF-06 (TRDD-3ZVURQ58)

## Files

the existing `llm-externalizer-usage` skill and its references, the top-level help source; to be listed at card start.

## Reuse

read the code at card start

## Steps

1. Add both groups, the five profile names and `profile-type` to the usage skill and its references (§13).
2. Add both groups to the `llm-ext --help` group list (§13).

## Acceptance

- [ ] the usage skill names both new groups
- [ ] `llm-ext --help` lists them
- [ ] CPV clean
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed (this card edits the top-level help text, so the help text is the only non-docs file touched; typecheck and lint stay clean)

## Out of scope

The new skills (DOC-03, DOC-09).
