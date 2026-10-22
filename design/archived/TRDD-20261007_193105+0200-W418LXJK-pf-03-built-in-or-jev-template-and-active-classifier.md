---
trdd-id: W418LXJK
title: PF-03 Built-in or-jev template and active_classifier
column: complete
status: archived
created: 2026-10-07T19:31:05+0200
updated: 2026-10-10T00:56:12+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:05+0200
implementation-commits: [3e16f0a1, e8d7d255, 0421472e]
---

# PF-03 Built-in or-jev template and active_classifier

## Goal
Write the built-in `or-jev` classifier profile (`~typesafe/jev-latest`) with its marker on fresh install and add `active_classifier`.

## Approval log

- 2026-10-07T19:31:05+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:56:07+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:56:09+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:56:12+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§8 (five built-in profiles), D19, D24; E82; E112 (card RL-06 per §12).

## Depends on

PF-01 (TRDD-82LIQI5I), PT-04 (TRDD-N2L9BN1Q)

## Files

- `scripts/llm-ext/src/config.ts` (template, `active_classifier`)
- tests and the vitest include entry: to be listed at card start

## Reuse

- the PT-04 scouting template pattern
- read the code at card start for marker handling

## Steps

1. Add the `or-jev` template: classifier type, model `~typesafe/jev-latest`.
2. Write it on fresh install with the generated marker and set `active_classifier: or-jev`.
3. `active_classifier` naming a missing profile is an error.
4. Add WHY comments (alias choice, D24).

## Acceptance

- [x] written on fresh install with marker (E112; the E112 test itself belongs to RL-06 per §12)
- [x] E82: `active_classifier` names a missing profile → error
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 3e16f0a1 (one commit for PT-06 and PF-03), e8d7d255 (test include list), 0421472e (rebuilt dist) — config.ts or-jev classifier template written on a fresh install with the marker, active_classifier setting, activeClassifierErrors (E82), or-jev-template.test.ts. The E112 test itself belongs to RL-06. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. OPEN ITEMS: an existing hand-written unmarked or-jev is refused as a reserved name until PF-04 lands; active_classifier naming a non-classifier profile is not a load error (L2-17 owns that check); existing installs get neither or-jev nor active_classifier until PF-04.

## Out of scope

The migration for existing installs (PF-04), the YAML example comment (PT-07).
