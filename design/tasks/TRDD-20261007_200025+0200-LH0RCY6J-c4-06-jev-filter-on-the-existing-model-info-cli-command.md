---
trdd-id: LH0RCY6J
title: C4-06 Jev filter on the existing model-info CLI command
column: backburner
status: tasked
created: 2026-10-07T20:00:25+0200
updated: 2026-10-07T20:00:28+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:25+0200
---

# C4-06 Jev filter on the existing model-info CLI command

## Goal

Add a Jev filter to the existing model-info command so it lists decisions-catalog models and the current snapshot per alias, with no new command.

## Approval log

- 2026-10-07T20:00:25+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

D27, §8 Model rule (a missing model fails naming the model-info command's Jev filter, C4-06), §9 row "existing model-info command + Jev filter" (decisions catalog rows from `?output_modalities=decisions`, no Jev call), E19 (owned by PF-02).

## Depends on

L0-07 (TRDD-CASL940C)

## Files

`estimate.ts:167` (the `or_model_info` tool); the CLI command file: to be listed at card start (step 1).

## Reuse

`loadDecisionsCatalog` and `resolveModel` from L0 (plan §3); `estimate.ts:167`.

## Steps

1. Find the real CLI command behind `or_model_info` (`estimate.ts:167`, INFERRED to be in the `models` group) and record it on the card.
2. Add the Jev filter showing decisions catalog rows and the current snapshot per alias (via `alias_target`).
3. Add no new command (D27).

## Acceptance

- [ ] step 1 finds the real CLI command behind `or_model_info` (`estimate.ts:167`, INFERRED to be in the `models` group)
- [ ] decisions catalog rows and current snapshot per alias
- [ ] no new command (D27)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The catalog loader (L0-07), the selection error text (PF-02).
