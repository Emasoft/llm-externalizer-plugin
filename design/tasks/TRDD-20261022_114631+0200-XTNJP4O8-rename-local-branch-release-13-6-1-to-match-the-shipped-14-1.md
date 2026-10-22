---
trdd-id: XTNJP4O8
title: Rename local branch release/13.6.1 to match the shipped 14.1.x
column: backburner
status: tasked
created: 2026-10-22T11:46:31+0200
updated: 2026-10-22T11:49:37+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-22T11:46:31+0200
---

# Rename local branch release/13.6.1 to match the shipped 14.1.x

The release card FCWL7PXZ and the local branch release/13.6.1 still carry the 13.6.1 name, although the work shipped as v14.1.0 and v14.1.1. Rename the local branch only (or start a new one from it). Do NOT edit or rename the archived card: archived cards are immutable. The version mapping lives here: the work planned as 13.6.1 shipped as v14.1.0 (squash 4bdd9b1b, release 8cbd288b) and v14.1.1 (squash 4b36c0c4, release 0e5fc3e9). FCWL7PXZ implementation-commits stops at 54d72244 because the card was archived before it could be extended; the 14.1.1 commits are 08585fab (gated debug-log test), a9bb8903 (/tmp CI fix), 5f05efe0 (changelog fix), 4b36c0c4 and 0e5fc3e9 (squash and release), 2a34fffa (local cherry-pick). The planned rewrite of the public history (tracked on a machine-local card) will replace these ids; the release record TRDD-MPKOZIH0 carries the public ids. Cosmetic; no code change.

## Approval log

- 2026-10-22T11:46:31+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] the local branch no longer carries the 13.6.1 name, and its tip commit equals the old branch tip recorded before the rename
