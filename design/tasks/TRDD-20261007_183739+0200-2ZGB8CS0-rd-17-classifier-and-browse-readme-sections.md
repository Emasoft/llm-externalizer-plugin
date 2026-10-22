---
trdd-id: 2ZGB8CS0
title: RD-17 Classifier and browse README sections
column: backburner
status: tasked
created: 2026-10-07T18:37:39+0200
updated: 2026-10-07T18:40:33+0200
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:37:39+0200
target-release: 14.2.0
---

# RD-17 Classifier and browse README sections

## Goal
Classifier and browse README sections in the same style; sole owner of those README sections.

## Plan refs
§13b (RD-17 row, order paragraph: joins 14.2.0); D25; DOC-10.

## Depends on
Depends on: RD-15 (TRDD-2CRNDA6Z), RD-19 (TRDD-XJKL495A), C4-03 (TRDD-4Q1IVJOE), BR-03 (TRDD-TRDGXSF0)

## Files
Files: to be listed at card start (the plan names: README sections; chart data from classify-eval and RD-19's matrix).

## Reuse
Reuse: read the code at card start

## Steps
1. Add the sections when 14.2.0's commands exist (derived from done-when).
2. Extend RD-19's matrix with an `or-jev` column for the classify commands, same JSON schema, each cell tagged `basis: per-run (RD-19 fixture)` or `basis: per-item (EV-08 dataset)` (derived from done-when).
3. Draw the `or-jev` column as its own chart because the bases differ (derived from done-when).
4. Fill it from EV-08's measured cost per item, no new runs (derived from done-when).

## Acceptance
- [ ] sections added when 14.2.0 commands exist
- [ ] `or-jev` column in the same JSON schema, cells tagged with `basis`
- [ ] `or-jev` drawn as its own chart
- [ ] filled from EV-08 measured cost per item, no new runs
- [ ] definition of done for a docs or study card: the RD-15 README-vs-CLI test green when the README is touched; one commit with the card id in its subject; no code changed

## Out of scope
Compatibility table (RD-20); DOC-10 docs pages.

## Approval log

- 2026-10-07T18:37:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
