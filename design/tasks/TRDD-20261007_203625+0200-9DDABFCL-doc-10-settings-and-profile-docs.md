---
trdd-id: 9DDABFCL
title: DOC-10 Settings and profile docs
column: backburner
status: tasked
created: 2026-10-07T20:36:25+0200
updated: 2026-10-07T20:36:33+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:36:25+0200
---

# DOC-10 Settings and profile docs

## Goal
Docs pages for settings and profiles: `profile-type`, `active_classifier`, the five defaults, classifiers paid with an opt-in `--max-budget`, `allow_paid_models` for chat profiles only.

## Approval log

- 2026-10-07T20:36:25+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-10); §16 card template and definition of done; §17; D2, D19, D20, D36

## Depends on

PF-06 (TRDD-3ZVURQ58)

## Files

`docs/*.md` (README sections are RD-17's); to be listed at card start for the file names.

## Reuse

read the code at card start

## Steps

1. Document `profile-type`, `active_classifier`, the five defaults (`free`, `paid`, `local`, `scouting`, `or-jev`), that classifiers are paid with an opt-in `--max-budget`, and that `allow_paid_models` applies to chat profiles only (§13).
2. Leave the README sections to RD-17 (title).

## Acceptance

- [ ] (derived from title) docs pages state profile-type, active_classifier, the five defaults, the D2 spend rule and the D36 `allow_paid_models` scope
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

README sections (RD-17).
