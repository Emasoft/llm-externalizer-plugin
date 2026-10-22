---
trdd-id: PANO8WS4
title: L1-08 Model-id helpers
column: complete
status: archived
created: 2026-10-07T19:21:13+0200
updated: 2026-10-09T23:30:03+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:13+0200
implementation-commits: [be8a781a]
---

# L1-08 Model-id helpers

## Goal
Helpers that parse a served build (snapshot) from a model id and compare an alias with a served build.

## Approval log

- 2026-10-07T19:21:13+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:30:02+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:03+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:03+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (`l1/model-id.ts`: model ids and snapshots), §7 (Snapshot), D24.

## Depends on

L0-08 (TRDD-MKEWC00E)

## Files

- `scripts/llm-ext/src/classifiers/l1/model-id.ts`
- `scripts/llm-ext/src/classifiers/l1/model-id.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`resolveModel` from L0-08 (alias to target). Read the code at card start.

## Steps

1. Snapshot parse: extract the served build from a reply `model` value. (derived from done-when)
2. Alias compare: decide whether a served build belongs to a requested alias, using the alias target from `resolveModel`. (derived from done-when)

## Acceptance

- [x] snapshot parse
- [x] alias compare
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed be8a781a — l1/model-id.ts parseSnapshot, isServedBuildOf, 5 tests. Whole package, run by the coordinator on the committed tree: npm test 215 files passed / 4 skipped, 3414 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet, build 0 per the integration worker; the real settings.yaml hash unchanged.

## Out of scope

Catalog loading and alias resolution (L0-07, L0-08), the mid-run alias-move warning (L2-04).
