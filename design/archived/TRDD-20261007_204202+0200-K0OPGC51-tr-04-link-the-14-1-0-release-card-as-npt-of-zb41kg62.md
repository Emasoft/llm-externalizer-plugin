---
trdd-id: K0OPGC51
title: TR-04 Link the 14.1.0 release card as npt of ZB41KG62
column: complete
status: archived
created: 2026-10-07T20:42:02+0200
updated: 2026-10-07T20:46:18+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:42:02+0200
---

# TR-04 Link the 14.1.0 release card as npt of ZB41KG62

## Goal
Set the 14.1.0 release card as `npt` of TRDD-ZB41KG62.

## Approval log

- 2026-10-07T20:42:02+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-07T20:46:18+0200 — COMPLETE by main-agent@llm-externalizer-plugin. done before minting; ZB41KG62 npt WBZJRSQB; commit 0b9198c.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 TR table (row TR-04); §15; §17

## Depends on

TR-01 (TRDD-AYJD3OD5)

## Files

the card for TRDD-ZB41KG62 (edited with trddgrep)

## Reuse

trddgrep set, append and edit (§17)

## Steps

1. Set `npt:` of TRDD-ZB41KG62 to the 14.1.0 release card (§15).

## Acceptance

- [x] (derived from title) TRDD-ZB41KG62's `npt:` names the 14.1.0 release card and `trddgrep lint` stays clean
- ~~[ ] definition of done for a housekeeping card: trddgrep lint clean on the cards it touches; one commit with the TRDD id in its subject~~ — struck: work done before the card existed; the npt was set earlier without a card id

## Out of scope

Other fixes to TRDD-ZB41KG62 (TR-01).

## Status

done: ZB41KG62 has npt [WBZJRSQB], the 14.1.0 release card
