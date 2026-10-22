---
trdd-id: OZ0EX1CN
title: BR-06 Page extraction and JUNK_NAMES
column: backburner
status: tasked
created: 2026-10-07T20:01:04+0200
updated: 2026-10-07T20:01:07+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:04+0200
---

# BR-06 Page extraction and JUNK_NAMES

## Goal

Extract actionable page elements as observables with stable ids, filtering names with `JUNK_NAMES`.

## Approval log

- 2026-10-07T20:01:04+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (extraction, observables; `JUNK_NAMES` kept verbatim and documented as Wikipedia-tuned, study 2), §10 Per-step fan-out (action choice over pruned elements).

## Depends on

BR-04 (TRDD-45XGJJ1M)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Extract elements as observables with ids that stay the same across extractions.
3. Keep `JUNK_NAMES` verbatim and document it as Wikipedia-tuned.

## Acceptance

- [ ] observables with stable ids
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Payload and trim (BR-07), bot detection (BR-13), final page formats (BR-26).
