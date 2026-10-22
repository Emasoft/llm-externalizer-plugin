---
trdd-id: XD2GFRZD
title: TR-03 Cross-note in TRDD-KV2WCFCS
column: superseded
status: archived
created: 2026-10-07T20:41:57+0200
updated: 2026-10-07T20:42:50+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:57+0200
superseded-by: [ZB41KG62]
---

# TR-03 Cross-note in TRDD-KV2WCFCS

## Goal
Add a cross-note to TRDD-KV2WCFCS replacing "every classifier tool must be in `free-forbidden-tools.test.ts`".

## Approval log

- 2026-10-07T20:41:57+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-07T20:42:50+0200 — SUPERSEDED by main-agent@llm-externalizer-plugin. TRDD-KV2WCFCS is archived and immutable; the cross-note lives on ZB41KG62.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 TR table (row TR-03); §15; §17; D2

## Depends on

TR-01 (TRDD-AYJD3OD5)

## Files

the card for TRDD-KV2WCFCS (edited with trddgrep)

## Reuse

trddgrep set, append and edit (§17)

## Steps

1. Append the cross-note: a `CLASSIFIER_TOOLS` category derived from the catalog registry, exempt from the free-only rule with the reason "classifiers are paid by design (D2)", plus an assertion that every tool that can send a decisions request is in that list (PF-10) (§15).
2. Derived from title: use `trddgrep append`.

## Acceptance

- [ ] (derived from title) TRDD-KV2WCFCS carries the cross-note with the D2 reason and the PF-10 assertion
- [ ] definition of done for a housekeeping card: trddgrep lint clean on the cards it touches; one commit with the TRDD id in its subject

## Out of scope

The TRDD-ZB41KG62 edit (TR-01); the assertion code (PF-10).

## Status

superseded: TRDD-KV2WCFCS is archived and immutable, so the cross-note lives on ZB41KG62
