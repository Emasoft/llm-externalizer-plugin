---
trdd-id: E1KU67RT
title: EV-08 benchmark classify-eval command and report
column: backburner
status: tasked
created: 2026-10-07T20:29:22+0200
updated: 2026-10-07T20:29:25+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:22+0200
---

# EV-08 benchmark classify-eval command and report

## Goal
Add the `benchmark classify-eval` command that runs the evaluation and writes a report.

## Approval log

- 2026-10-07T20:29:22+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (`classify-eval` row), §16 (EV table), D3, D12.

## Depends on

EV-06 (TRDD-F7W4KJ5O), EV-07 (TRDD-HR1L160I)

## Files

- To be listed at card start (command wiring, report writer, tests, vitest include entry).

## Reuse

Read the code at card start (existing `benchmark` subcommands; `benchmark/workload-kit.ts` report step).

## Steps

1. Wire the command to the EV-06 runner and the EV-07 budget (derived from npt).
2. Write the report (derived from title; §11 lists accuracy, Brier, review rate, cost per item, per snapshot).
3. Run it live on the seed datasets; it spends Jev credit, needs no go-ahead and has no cap; print and record the cost (D2, D12).

## Acceptance

- [ ] `benchmark classify-eval` runs and writes a report (derived from title; the plan gives no done-when)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

`--if-changed` (DW-03), threshold suggestions (EV-09).
