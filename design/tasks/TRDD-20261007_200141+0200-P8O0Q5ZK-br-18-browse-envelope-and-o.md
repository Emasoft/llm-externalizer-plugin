---
trdd-id: P8O0Q5ZK
title: BR-18 Browse envelope and -o
column: backburner
status: tasked
created: 2026-10-07T20:01:41+0200
updated: 2026-10-07T20:01:44+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:41+0200
---

# BR-18 Browse envelope and -o

## Goal

Wrap the browse result in the llm-ext envelope and support `-o`.

## Approval log

- 2026-10-07T20:01:41+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (result object keeps the jev-browser shape, inventory §5.4, inside the llm-ext envelope), D10, E52 (owned by L2-16).

## Depends on

BR-08 (TRDD-5D4X8KFN), L2-16 (TRDD-FFWAXZRN)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

`l2/envelope.ts`, `l2/report.ts` (plan §3); read the code at card start.

## Steps

1. Build the result in the jev-browser shape and put it inside the L2 envelope.
2. Wire `-o` to the L2-16 report writer.

## Acceptance

- [ ] result in the jev-browser shape inside the llm-ext envelope
- [ ] `-o` saves the report
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Report writer (L2-16), final page formats (BR-26).
