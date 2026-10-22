---
trdd-id: YGS3IEJF
title: DOC-03 llm-externalizer-classify SKILL.md
column: backburner
status: tasked
created: 2026-10-07T20:35:43+0200
updated: 2026-10-07T20:35:46+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:35:43+0200
---

# DOC-03 llm-externalizer-classify SKILL.md

## Goal
The classify skill's SKILL.md: when to use a classifier vs a chat model, decision map (question to command), cost, profiles, strict-exit in scripts.

## Approval log

- 2026-10-07T20:35:43+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-03); §16 card template and definition of done; §17

## Depends on

DOC-01 (TRDD-EGFYCVC9), C4-03 (TRDD-4Q1IVJOE)

## Files

`skills/llm-externalizer-classify/SKILL.md`; to be listed at card start for anything else.

## Reuse

read the code at card start

## Steps

1. Write SKILL.md with: when to use a classifier vs a chat model, decision map (question to command), cost, profiles, strict-exit in scripts (§13).
2. Derived from title: link the rulebook copy in `references/` (the copy itself is DOC-02).

## Acceptance

- [ ] (derived from title) SKILL.md exists and covers: classifier vs chat model, decision map, cost, profiles, strict-exit in scripts
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

References files (DOC-04…DOC-08); the rulebook (DOC-01).
