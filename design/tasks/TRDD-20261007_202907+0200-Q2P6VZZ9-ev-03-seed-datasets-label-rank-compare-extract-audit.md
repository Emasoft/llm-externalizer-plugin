---
trdd-id: Q2P6VZZ9
title: EV-03 Seed datasets label rank compare extract audit
column: backburner
status: tasked
created: 2026-10-07T20:29:07+0200
updated: 2026-10-07T20:29:10+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:07+0200
---

# EV-03 Seed datasets label rank compare extract audit

## Goal
Write seed labelled datasets for the specs label, rank, compare, extract and audit, in the EV-01 format.

## Approval log

- 2026-10-07T20:29:07+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (`classify-eval` row), §16 (EV table), D21; EV datasets carry no private data (assignment rule).

## Depends on

EV-01 (TRDD-ABPSC16L)

## Files

- Dataset jsonl files for the 5 specs, location to be listed at card start.

## Reuse

Read the code at card start (EV-01 format).

## Steps

1. Write labelled items for each of the 5 specs in the EV-01 format (derived from done-when).
2. Use invented or public text only; no private data (assignment rule).
3. Fingerprint each file via the EV-01 tool (derived from §11).
4. Grep the files for home paths, usernames and keys (derived from the assignment rule).

## Acceptance

- [ ] one jsonl file per listed spec in the EV-01 format
- [ ] definition of done for a dataset card: jsonl files in the EV-01 format, fingerprinted, no private data (checked by grep for home paths, usernames, keys), one commit with the TRDD id in its subject

## Out of scope

Other specs' datasets (EV-02, EV-04).
