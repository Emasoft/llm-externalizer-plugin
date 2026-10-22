---
trdd-id: OX99FFC3
title: P-02 Free catalog snapshot
column: complete
status: archived
created: 2026-10-07T18:46:38+0200
updated: 2026-10-09T21:48:12+0200
current-owner: user
created-by: user
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:46:38+0200
---

# P-02 Free catalog snapshot

## Goal
Capture real catalog and key-info replies from OpenRouter, at no cost, as raw fixtures.

## Approval log

- 2026-10-07T18:46:38+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T21:43:14+0200 — column → todo by user. USER 2026-10-09: complete the jev plan
- 2026-10-09T21:43:14+0200 — column → dev. probe started 2026-10-09
- 2026-10-09T21:48:12+0200 — COMPLETE by main-agent@llm-externalizer-plugin. probe done, captures verified.

## Plan refs

§1 D21; §3 L0 (`l0/catalog.ts`); §4 (model limits from the decisions catalog); §16 P table; §18 (P-02 is captured when coding starts, because the catalog moves).

## Depends on

none (plan npt: —)

## Files

To be listed at card start. Raw captures feed P-03.

## Reuse

Read the code at card start.

## Steps

1. (derived from done-when) Take the API key from the environment only.
2. Capture the reply of `?output_modalities=decisions`.
3. Capture one alias model's catalog entry.
4. Capture `/endpoints` for the alias and for its target.
5. Capture `GET /api/v1/key`.
6. (derived from done-when) Print the cost (zero) and record it on the card.

## Acceptance

- [x] fixture of `?output_modalities=decisions`
- [x] fixture of an alias model
- [x] fixtures of alias and target `/endpoints`
- [x] fixture of `GET /api/v1/key`
- [x] definition of done for a probe card: raw replies saved outside the repo (reports/), cost printed and recorded on the card
RESULT 2026-10-09 (verified by the coordinator: files present, grep for the API key in every saved file = 0): raw captures in reports/classifiers-probe/p02/ (models-decisions.json 14733 B, models-all.json, alias-entry.json, alias-endpoints.json, target-endpoints.json, key.json, each with its headers file; all HTTP 200); report reports/classifiers-probe/20261009-p02-report.md; cost 0 USD (GET only). Findings for L0-07 and section 4: 16 models carry the decisions output modality; ~typesafe/jev-latest resolves to typesafe/jev-1.13 through the alias entry field alias_target; the alias has NO endpoints of its own (data.endpoints = []) and context_length null, so limits and provider status must be read from the target; the target has exactly one endpoint (provider TypeSafe) with supported_parameters [].

## Out of scope

Sanitizing and storing (P-03), the catalog loader (L0-07).
