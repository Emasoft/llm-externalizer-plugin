---
trdd-id: 2UDJT2DB
title: DOC-08 presets.md and the when-to-use-which guide
column: backburner
status: tasked
created: 2026-10-07T20:36:04+0200
updated: 2026-10-07T20:36:13+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:36:04+0200
---

# DOC-08 presets.md and the when-to-use-which guide

## Goal
The classify skill's `references/presets.md` plus the "when to use which command, and when to just read" guide with the cost study break-evens.

## Approval log

- 2026-10-07T20:36:04+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-08); §16 card template and definition of done; §17; D15, D27

## Depends on

SP-13 (TRDD-0JLI6PGT)

## Files

`skills/llm-externalizer-classify/references/presets.md`; the guide's file is to be listed at card start.

## Reuse

read the code at card start

## Steps

1. Document the two presets `invariant-check` and `criterion-vs-tests` (D15).
2. Write the "when to use which command, and when to just read" guide using the cost study break-evens (§13) (derived from title).

## Acceptance

- [ ] (derived from title) presets.md exists and covers both presets
- [ ] (derived from title) the when-to-use-which guide exists and cites the cost study break-evens
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

Preset code (SP-13).
