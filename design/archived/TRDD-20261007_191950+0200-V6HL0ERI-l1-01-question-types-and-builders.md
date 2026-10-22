---
trdd-id: V6HL0ERI
title: L1-01 Question types and builders
column: complete
status: archived
created: 2026-10-07T19:19:50+0200
updated: 2026-10-10T00:01:06+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:19:50+0200
implementation-commits: [3e9b7835, 70083966]
---

# L1-01 Question types and builders

## Goal
Question types (noul, choice, score) and their builders, refusing malformed questions at build time.

## Approval log

- 2026-10-07T19:19:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:30:19+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:30:19+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:01:06+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 (L1 primitives, the `Question` type), §2b (OpenRouterTeam/typescript-sdk: wire types as the cross-check for L1); P-01 fixtures (allowed question-key characters and length); E30, E31, E32.

## Depends on

P-03 (TRDD-OP8ZMLOZ)

## Files

- `scripts/llm-ext/src/classifiers/l1/questions.ts`
- `scripts/llm-ext/src/classifiers/l1/questions.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Define the `Question` union as in §3: noul (instructions, optional criteria true/false), choice (instructions, criteria map of key to text or null), score (instructions, criteria list). (derived from done-when)
2. Builders refuse a question or criteria key outside the key pattern recorded by P-01 (E30).
3. The choice builder refuses fewer than 2 options (E31).
4. Every builder refuses empty instructions (E32).
5. The score builder refuses an empty criteria list. (derived from done-when)
6. Cross-check the type shapes against the typescript-sdk wire types named in §2b. (derived from done-when)

## Acceptance

- [x] key pattern enforced
- [x] choice needs at least 2 options
- [x] instructions must be non-empty
- [x] score needs at least 1 criterion
- [x] E30: Question or criteria key with characters the API rejects → refused at build (pattern from P-01)
- [x] E31: Choice with fewer than 2 options → refused at build
- [x] E32: Empty instructions → refused at build
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
PARTIAL 2026-10-09: committed 3e9b7835 — l1/questions.ts, 13 tests, shapes checked against the probe's accepted request bodies. E30 enforced as non-empty only (the probe found no pattern or length limit). NOT DONE: step 6, the cross-check against OpenRouter's TypeScript SDK (not on disk; fetch it). Whole package, run by the coordinator on the committed tree: npm test 215 files passed / 4 skipped, 3414 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet, build 0 per the integration worker; the real settings.yaml hash unchanged.
RESULT 2026-10-09: step 6 done (report docs_dev/20261009-L1-01-sdk-crosscheck.md) against @openrouter/sdk 1.4.25 and OpenRouterTeam/typescript-sdk commit bfe7530. 15 fields compared, 9 differences, all of them questions.ts being stricter than the schema (strings only for instructions and criteria; at least 2 choice options; no whitespace-only text; no empty choice key although the API accepts one); none sends something the API rejects. Null noul criteria are now refused with a build error (70083966). The SDK's own URL joining would reach https://openrouter.ai/systemone, which is not the API route, so the transport keeps the probe-verified URLs. Commits 3e9b7835, 70083966. Whole package: full suite 225 files / 3569 passed / 0 failed on the committed tree, tsc and eslint clean.

## Out of scope

Request-level size and count checks (L1-02), answer validation (L1-03 to L1-06).
