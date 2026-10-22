---
trdd-id: 9CHYVUCK
title: DOC-14 CPV validation of both skills
column: backburner
status: tasked
created: 2026-10-07T20:38:20+0200
updated: 2026-10-07T20:38:46+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:38:20+0200
---

# DOC-14 CPV validation of both skills

## Goal
Both new skills pass CPV validation.

## Approval log

- 2026-10-07T20:38:20+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-14); §16 card template and definition of done; §17

## Depends on

DOC-03 (TRDD-YGS3IEJF), DOC-09 (TRDD-OWJJEWBU)

## Files

none changed unless CPV reports a defect; fixes go in the skill files to be listed at card start.

## Reuse

read the code at card start

## Steps

1. Run CPV on `llm-externalizer-classify` and `llm-externalizer-browse`.
2. Fix every finding (derived from done-when).

## Acceptance

- [ ] clean
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed
- [ ] CPV report clean, its output recorded on the card

## Out of scope

Skill content (DOC-03, DOC-09).
