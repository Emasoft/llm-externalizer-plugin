---
trdd-id: ZVS3IMKT
title: RL-13 Close cards, update ZB41KG62 STATE
column: todo
status: tasked
created: 2026-10-07T20:41:39+0200
updated: 2026-11-19T01:10:02+0100
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:41:39+0200
---

# RL-13 Close cards, update ZB41KG62 STATE

## Goal
Close the plan's cards and update TRDD-ZB41KG62's STATE.

## Approval log

- 2026-10-07T20:41:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T17:16:52+0100 — column → todo by main-agent@llm-externalizer-plugin. release checklist for 14.3.0

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §16 RL table (row RL-13); §17 execution step 6; D13; §15

## Depends on

RL-12 (TRDD-BJ8T8MKE)

## Files

to be listed at card start

## Reuse

read the code at card start

## Steps

1. Close every finished card (derived from title).
2. Update TRDD-ZB41KG62's STATE block (title).
3. RL-13 is an `eht` of TRDD-ZB41KG62 (§15).

## Acceptance

- [ ] (derived from title) every finished card is closed and ZB41KG62's STATE is updated
- [ ] definition of done for a release step: the step's command output recorded on the card; nothing pushed, published or installed without the USER's word; RL-10 and RL-12 wait for the USER (D13)

## Out of scope

Publishing (RL-10).

## Coordinator note 2026-10-31

Retargeted to 14.3.0: 14.2.0 was published 2026-10-31 as the local broker release. These cards are the 14.3.0 release checklist; RL-10 publish is authorized by the user goal of 2026-10-31 (publish and install when all TRDDs are complete).

## Notes

2026-11-16T10:27:58+0100 RETARGETED by the main agent (goal TRDD-FC2TX9VU): 14.3.0 was published 2026-11-15 by the TRDD-EB1XGLMJ run, not through this checklist, so every 14.3.0 in this card now means the next release after 14.3.0 (version set by git-cliff at publish). The card stays open and is worked at that release. RL-10 USER gate: the USER goal of 2026-11-16 says publish and update.
2026-11-18T16:42:19+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): scope reduced. This card closes only the finished cards and refreshes the ZB41KG62 STATE; it no longer waits for a release. Reduced scope: (a) archive every card in design/tasks whose column is complete, published, superseded or cancelled; (b) append the refreshed NEXT ACTION to ZB41KG62; (c) record the commands run. The per-card audit of the backburner children is not part of this card; it goes to a new card (see ZB41KG62 STATE). RL-10 publish stays a separate USER-gated act. Fact: NL2012O9, 09905HDI and H0JE5W6K are column complete with release-via publish, so they reach published (and archive) only with the next release; this card ticks its boxes after that.
2026-11-19T01:06:05+0100 box 1 ticked (worker, checks 2026-11-19): grep -lE '^column: (complete|published|superseded|cancelled|completed|live)$' over design/tasks/*.md finds no card, after NL2012O9, 09905HDI and H0JE5W6K were moved to published and archived on 2026-11-19 (shipped in v14.7.3, release https://github.com/Emasoft/llm-externalizer-plugin/releases/tag/v14.7.3); TRDD-ZB41KG62 STATE carries a NEXT ACTION line dated 2026-11-18T16:42:26+0100. Box 2 stays open: it requires RL-10 and RL-12 to wait for the USER and the step's command output recorded on the card, which the 14.7.3 publish facts do not satisfy. Card stays in todo. ZB41KG62's line says releases through v14.7.2; v14.7.3 is not in it.
2026-11-19T01:10:01+0100 box 1 UNTICKED by the worker after review: the earlier tick rested only on a column grep over design/tasks; ZB41KG62's STATE NEXT ACTION says releases through v14.7.2 (not v14.7.3) and ZTO9K8EK stays in publish with v14.7.3 shipped. The main agent decides after refreshing ZB41KG62's STATE.
