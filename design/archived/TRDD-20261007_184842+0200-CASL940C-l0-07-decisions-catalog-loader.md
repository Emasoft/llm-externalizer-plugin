---
trdd-id: CASL940C
title: L0-07 Decisions catalog loader
column: complete
status: archived
created: 2026-10-07T18:48:42+0200
updated: 2026-10-09T22:35:50+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:48:42+0200
implementation-commits: [3f29ce52]
---

# L0-07 Decisions catalog loader

## Goal
Load the decisions model catalog (`?output_modalities=decisions`) with its own cache, TTL and lock.

## Approval log

- 2026-10-07T18:48:42+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:35:49+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:35:49+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:35:50+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 L0 (`l0/catalog.ts`: `loadDecisionsCatalog`, `DecisionsModel`; reuses `getCatalog({path})`, `withMkdirLock`); §4 (model limits come from the decisions catalog); D9; E16.

## Depends on

P-03 (TRDD-OP8ZMLOZ)

## Files

- `scripts/llm-ext/src/classifiers/l0/catalog.ts`
- `scripts/llm-ext/src/classifiers/l0/catalog.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`getCatalog({path})`, `withMkdirLock`. Other reuse: read the code at card start.

## Steps

1. Load through `getCatalog({path})` with a separate cache path for the decisions catalog.
2. Apply the TTL and take the lock with `withMkdirLock`.
3. Map entries to `DecisionsModel` (id, canonicalSlug, aliasTarget, contextTokens, promptUsdPerM, outputModalities, systemOne).
4. An expired cache with a failed refresh is an error naming the catalog URL (E16).
5. Replay the P-02 fixture through the `GlobalFetch` seam. (derived from done-when)

## Acceptance

- [x] E16: Catalog unreachable, cache expired → error naming the catalog URL
- [x] separate cache path
- [x] TTL honoured
- [x] lock taken
- [x] expired cache plus failed refresh is an error
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 3f29ce52 — src/classifiers/l0/catalog.ts, 9 tests over the real P-02 catalog fixture. KNOWN LIMIT: withMkdirLock is synchronous, so the lock covers the cache read and TTL check only, not the fetch or cache write (two processes may both refresh). FACT for L0-08: the catalog gives the alias ~typesafe/jev-latest context_length 64000, while the target endpoint reports max_prompt_tokens 32000 and the probe measured about 32k; read the limit from the endpoint, not the catalog. Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 206 files passed / 4 skipped, 3311 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave3-integration.md).

## Out of scope

Model resolution (L0-08), profile validation against the catalog (PF cards).
