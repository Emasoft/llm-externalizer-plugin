---
trdd-id: YAXJPUPI
title: L2-02 Planner unsplittable and renumber
column: complete
status: archived
created: 2026-10-07T19:21:35+0200
updated: 2026-10-10T00:49:52+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:35+0200
implementation-commits: [539e0804, e8d7d255, 0421472e]
---

# L2-02 Planner unsplittable and renumber

## Goal
Planner support for unsplittable questions and for renumbering per-chunk references.

## Approval log

- 2026-10-07T19:21:35+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:49:48+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:49:50+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:49:52+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§5 (`unsplittable`, `renumber(units, offset)`, caller table); E28, E44, E45.

## Depends on

L2-01 (TRDD-YB1KEVKC)

## Files

- `scripts/llm-ext/src/classifiers/l2/planner.ts`
- `scripts/llm-ext/src/classifiers/l2/planner.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. An unsplittable question goes in one request together with all units it references (§5).
2. When an unsplittable question plus its units exceed one request, refuse (E44).
3. `renumber(units, offset)` rewrites `claims[i]`-style references per chunk and maps them back to global ids (E45).
4. Assert that question keys cannot collide after a chunk merge (E28: impossible by construction; asserted).

## Acceptance

- [x] E28: Question-key collision after chunk merge → impossible by construction; asserted
- [x] E44: Unsplittable question plus units exceed one request → refused
- [x] E45: Per-chunk `claims[i]` references → renumbered and mapped back to global ids
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 539e0804 (one commit for L2-01, L2-02 and L2-03), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/planner.ts planRequests unsplittable branch and renumber hook, assertUniqueKeys, toGlobalIndex, Refusal kinds unsplittable-too-large and unsplittable-too-many-questions; l2/planner.test.ts (describe L2-02). E28 (duplicate keys throw, a renumber that changes keys is refused), E44 and E45 pinned by tests. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. OPEN ITEMS: an unsplittable question is treated as referencing ALL units (plan section 5 says units they reference; Built has no reference list), conservative, may refuse a job a subset reading would plan.

## Out of scope

Core packing (L2-01), merge rules for chunks (L2-19).
