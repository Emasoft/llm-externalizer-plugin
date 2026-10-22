---
trdd-id: 6GVS91R4
title: WK-09 Remove dead duplicates and sweep
column: backburner
status: tasked
created: 2026-10-07T20:28:58+0200
updated: 2026-10-07T20:29:01+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:28:58+0200
---

# WK-09 Remove dead duplicates and sweep

## Goal
Delete the duplicate helpers left in the 6 workloads after migration and sweep for references.

## Approval log

- 2026-10-07T20:28:58+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (workload-kit row), §16 (WK table), D16.

## Depends on

WK-03 (TRDD-Q4IAI6H1), WK-04 (TRDD-57INC9NA), WK-05 (TRDD-8QS0DYB4), WK-06 (TRDD-TF4UNJNG), WK-07 (TRDD-AZY7ZZIS), WK-08 (TRDD-QMS5ITUB)

## Files

- To be listed at card start (the 6 workload files among the files under scripts/llm-ext/src/benchmark/, to be listed at card start).

## Reuse

Read the code at card start (`tldr references` for code, grep for docs and configs).

## Steps

1. For each helper now in `workload-kit.ts`, search the 6 workloads for a remaining copy (derived from done-when).
2. Remove each dead duplicate (derived from done-when).
3. Sweep code references with `tldr references`/`tldr impact` and non-code references with grep (derived from done-when).

## Acceptance

- [ ] no duplicate helper left
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

New kit steps (WK-02); migration (WK-03 to WK-08).
