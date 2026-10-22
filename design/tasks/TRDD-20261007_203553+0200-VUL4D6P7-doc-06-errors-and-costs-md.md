---
trdd-id: VUL4D6P7
title: DOC-06 errors-and-costs.md
column: backburner
status: tasked
created: 2026-10-07T20:35:53+0200
updated: 2026-10-07T20:35:56+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:35:53+0200
---

# DOC-06 errors-and-costs.md

## Goal
The classify skill's `references/errors-and-costs.md`.

## Approval log

- 2026-10-07T20:35:53+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-06); §16 card template and definition of done; §17; D2

## Depends on

L0-01 (TRDD-NL788NGR)

## Files

`skills/llm-externalizer-classify/references/errors-and-costs.md`.

## Reuse

read the code at card start

## Steps

1. Document the error classes from L0-01 and the cost rules (classifiers are paid, opt-in `--max-budget`, every run prints its cost; D2) (derived from title).

## Acceptance

- [ ] (derived from title) errors-and-costs.md exists and lists the L0-01 error classes and the D2 cost rule
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

Retry and transport code (L0 cards).
