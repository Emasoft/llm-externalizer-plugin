---
trdd-id: F7W4KJ5O
title: EV-06 Runner and ledger
column: backburner
status: tasked
created: 2026-10-07T20:29:16+0200
updated: 2026-10-07T20:29:19+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:16+0200
---

# EV-06 Runner and ledger

## Goal
Run each real spec through `runDecision` deps over the datasets and record results in a ledger.

## Approval log

- 2026-10-07T20:29:16+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§11 (`classify-eval` row), §16 (EV table), D2, D12, E101, E102.

## Depends on

EV-05 (TRDD-CXYG5IDX), C4-01 (TRDD-BUL4EEBP)

## Files

- To be listed at card start (runner, ledger, tests, vitest include entry).

## Reuse

`benchmark/workload-kit.ts` ledger and cached per-model loop steps (WK-02). Read the code at card start.

## Steps

1. Run the real spec through `runDecision` deps for every dataset item (§11).
2. Record results in the ledger with the spec hash in the cache key and the served snapshot (E101, E102).
3. Split results per snapshot (E101).
4. Print and record the run's cost; no spending go-ahead and no cap (D2, D12).

## Acceptance

- [ ] E101: snapshot changes during `classify-eval` → results split per snapshot
- [ ] E102: spec text changed since a ledger entry → cache entry invalid (spec hash in key)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Metrics (EV-05), the CLI command (EV-08), budget accounting (EV-07).
