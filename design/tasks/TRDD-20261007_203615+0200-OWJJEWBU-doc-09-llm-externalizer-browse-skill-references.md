---
trdd-id: OWJJEWBU
title: DOC-09 llm-externalizer-browse skill + references
column: backburner
status: tasked
created: 2026-10-07T20:36:15+0200
updated: 2026-10-07T20:36:24+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:36:15+0200
---

# DOC-09 llm-externalizer-browse skill + references

## Goal
The `llm-externalizer-browse` skill: SKILL.md plus references (install/doctor, safety: hosts, credentials, recording; statuses; costs).

## Approval log

- 2026-10-07T20:36:15+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-09); §16 card template and definition of done; §17; D23

## Depends on

BR-08 (TRDD-5D4X8KFN)

## Files

`skills/llm-externalizer-browse/SKILL.md`, `skills/llm-externalizer-browse/references/*`; to be listed at card start for the file names.

## Reuse

read the code at card start

## Steps

1. Write SKILL.md (§13).
2. Write references for install/doctor, safety (hosts, credentials, recording), statuses and costs (§13).
3. Document the password handoff-file deletion in `--help` and the skill (D23) (derived from D23).

## Acceptance

- [ ] (derived from title) SKILL.md and the four reference topics (install/doctor, safety, statuses, costs) exist
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

The rulebook copy (DOC-02).
