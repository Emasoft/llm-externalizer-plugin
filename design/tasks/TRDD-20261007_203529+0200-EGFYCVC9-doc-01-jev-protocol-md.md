---
trdd-id: EGFYCVC9
title: DOC-01 jev-protocol.md
column: backburner
status: tasked
created: 2026-10-07T20:35:29+0200
updated: 2026-10-07T20:35:33+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:35:29+0200
---

# DOC-01 jev-protocol.md

## Goal
One human-readable Jev rulebook of 38 merged rules, each with its source and its llm-ext command.

## Approval log

- 2026-10-07T20:35:29+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-01); §16 card template and definition of done; §17; D17

## Depends on

SEC-01 (TRDD-JGJ948C8)

## Files

`skills/_shared/jev-protocol.md` or a file under `scripts/llm-ext/docs-src/` (the location is decided in step 1); to be listed at card start for anything else.

## Reuse

read the code at card start

## Steps

1. Run CPV on a scratch copy to decide the source location (`skills/_shared/` or `scripts/llm-ext/docs-src/`) (done-when clause).
2. Write the 38 merged rules from study 2 (jev-mcp 13 policy rules + 7 classification-hygiene items, plus jev-browser, claude-jev, awesome-jev and jev-review rules), each with its source and its llm-ext command (derived from done-when).
3. Take licence notes from SEC-01 (D17): text from an unlicensed source is rewritten in our own words (derived from done-when).

## Acceptance

- [ ] step 1: CPV on a scratch copy decides the source location (`skills/_shared/` or `scripts/llm-ext/docs-src/`)
- [ ] 38 rules with sources
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

Copies into the skills and the drift test (DOC-02); NOTICE (DOC-15).
