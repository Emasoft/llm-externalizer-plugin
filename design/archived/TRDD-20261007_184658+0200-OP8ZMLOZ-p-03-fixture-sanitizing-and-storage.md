---
trdd-id: OP8ZMLOZ
title: P-03 Fixture sanitizing and storage
column: complete
status: archived
created: 2026-10-07T18:46:58+0200
updated: 2026-10-09T22:21:59+0200
current-owner: user
created-by: user
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:46:58+0200
implementation-commits: [538ce26]
---

# P-03 Fixture sanitizing and storage

## Goal
Store the P-01 and P-02 captures as sanitized fixtures under `src/classifiers/__fixtures__/`, with a test that scans them for secrets.

## Approval log

- 2026-10-07T18:46:58+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:21:53+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:21:57+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:21:59+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§1 D21; §18 (P-03 strips from the `/api/v1/key` reply the key label, usage and limit figures and any key prefix, not only `user_id`); §16 P table.

## Depends on

P-01 (TRDD-HVYKK7UF), P-02 (TRDD-OX99FFC3)

## Files

- `scripts/llm-ext/src/classifiers/__fixtures__/` (fixtures)
- a secret-scan test and a `scripts/llm-ext/vitest.config.ts` include entry (names to be listed at card start)

## Reuse

Read the code at card start.

## Steps

1. Strip the key, every `user_id`, the key label, usage and limit figures and any key prefix from each capture (§18).
2. Save the sanitized files under `src/classifiers/__fixtures__/`.
3. Write a test that scans every fixture for secrets and fails on a hit. (derived from done-when)
4. Add the test to the vitest include list. (derived from done-when)

## Acceptance

- [x] fixtures under `src/classifiers/__fixtures__/`
- [x] no key and no `user_id` in any fixture
- [x] a test scans the fixtures for secrets
- [x] the `/api/v1/key` fixture has no key label, usage or limit figures
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
- [x] fixtures carry no key, user_id, key label, usage or limit figures, or key prefix (checked by the secret-scan test)
RESULT 2026-10-09: committed 538ce26 — 103 fixtures (97 from P-01 under __fixtures__/p01, 6 from P-02 under p02) plus secrets.test.ts (3 tests; failed 2 of 3 before the fixtures existed; passes with OPENROUTER_API_KEY set, so the real-key check ran). Verified by the coordinator before staging, not only by the worker: header names across all fixtures are content-type and cache-control only; key.json body is {is_management_key, is_provisioning_key}; none of the raw key reply's string values (label, creator_user_id, workspace_id, rate_limit note) and none of its figures of 5+ digits appears in any fixture; no email, IP address, account name, cf-ray, cookie or request id; staged files = 105, all under __fixtures__/ plus vitest.config.ts, none under reports/. NOT committed: the sanitized copy of the full /models catalog (852 KB, public data, nothing reads it) was moved to reports/classifiers-probe/p03-not-committed/. Limit: only content-type and cache-control headers were kept, so no fixture carries Retry-After or rate-limit headers; a retry-header test needs a synthetic reply (D21) or a new capture. The full npm test was not re-run for this commit (fixtures and one test only); it runs with the next wave.

## Out of scope

Capturing (P-01, P-02), tolerance choice (P-04).
