---
trdd-id: JDMY8LPJ
title: L2-09 Evidence and state builder
column: complete
status: archived
created: 2026-10-07T19:22:22+0200
updated: 2026-10-10T00:50:37+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:22+0200
implementation-commits: [39c964e8, e8d7d255, 0421472e]
---

# L2-09 Evidence and state builder

## Goal
Build the evidence and state objects with indexed sources and truncation flags.

## Approval log

- 2026-10-07T19:22:22+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:50:30+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:50:34+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:50:37+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§3 (`l2/evidence.ts`), §5 (Truncation is a spec decision; incomplete-context policy), D5.

## Depends on

L2-06 (TRDD-SNZ17S5L)

## Files

- `scripts/llm-ext/src/classifiers/l2/evidence.ts`
- `scripts/llm-ext/src/classifiers/l2/evidence.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`readForJev` (L2-06). Read the code at card start.

## Steps

1. Build state from sources, each source carrying an index so instructions can refer to it by index (D5). (derived from done-when)
2. Record a truncation flag when a spec asks for truncate-and-flag (§5). (derived from done-when)

## Acceptance

- [x] indexed sources
- [x] truncation flags
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 39c964e8, e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/evidence.ts buildEvidence and sourceFromSnippet returning {sharedState, ctx}, l2/evidence.test.ts (8+ tests: indexed sources, truncation by characters or partial flag, surrogate-safe cut, ctx.truncated). build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Deviation: the state shape {sources:[{index,label,text,truncated}]} and the character unit are my choices (the card and plan do not fix them); the per-source truncated flag is extra to the plan's single ProjectCtx.truncated, left in. OPEN ITEMS: none.

## Out of scope

Deciding when to truncate (each spec, §5), file reading (L2-06).
