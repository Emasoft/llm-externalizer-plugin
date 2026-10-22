---
trdd-id: NL788NGR
title: L0-01 Error taxonomy and status mapping
column: complete
status: archived
created: 2026-10-07T18:47:22+0200
updated: 2026-10-09T22:35:36+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:47:22+0200
implementation-commits: [911cb8c9]
---

# L0-01 Error taxonomy and status mapping

## Goal
One error class set in `l0/errors.ts` mapping every decisions-API failure to a class, per §7.

## Approval log

- 2026-10-07T18:47:22+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T22:35:35+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:35:36+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T22:35:36+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 L0; §4 (error classes and messages: only `l0/errors.ts`); §7 (error list); E06, E07; D2, D7.

## Depends on

P-03 (TRDD-OP8ZMLOZ)

## Files

- `scripts/llm-ext/src/classifiers/l0/errors.ts`
- `scripts/llm-ext/src/classifiers/l0/errors.test.ts`
- `scripts/llm-ext/vitest.config.ts` (include entry)

## Reuse

`sanitizeProviderError` for the message (§3, §7). Other reuse: read the code at card start.

## Steps

1. Define the error carrying `status`, class, `limit_source`, `reason`, `provider_code` (§7). Classes: `auth`, `payment`, `in-flight-budget`, `key-limit`, `rate-limited`, `unavailable`, `context-overflow`, `bad-request`, `not-found`, `too-large`, `network`, `timeout`, `bad-response`.
2. Map statuses to classes from the P-01 fixtures; `max_tokens_exceeded` maps to `context-overflow` with the exact OpenRouter body captured by P-01.
3. Separate 402 in-flight budget (`limit_source: openrouter_in_flight_budget`) from 402 credits and key limit; the latter carry a `remedy_hint` (E06).
4. A 429 keeps `provider_code`, whether from the provider (no `X-RateLimit-*`) or the platform (E07).
5. Always keep the status (§7). Build the message through `sanitizeProviderError`. (derived from done-when)
6. WHY comments on the 402 split and the status rule.

## Acceptance

- [x] E06: 402 in-flight budget vs 402 credits/key limit → first retried; second not, `remedy_hint` shown
- [x] E07: 429 from provider (no `X-RateLimit-*`) vs platform → both retried; class carries `provider_code`
- [x] every class of §7 produced from fixtures
- [x] 402 variants
- [x] 429 `provider_code`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed 911cb8c9 — src/classifiers/l0/errors.ts (ClassifierError, classifyHttpError, networkError, timeoutError, badResponseError), 15 tests. Retry and never-retry sets read by the coordinator against plan section 7: match. Not observed by the probe, tested with synthetic replies only: 402 variants, 429, 5xx, 408, 409; the in-flight-budget 402 is recognised by the plan's marker text, no real reply of that kind exists. Probe facts that differ from the plan: unknown model is 400 (classified not-found by the reply text), max_tokens_exceeded is 400 (context-overflow). Whole package after the wave: tsc 0, eslint . --quiet 0, npm test 206 files passed / 4 skipped, 3311 tests passed / 5 skipped / 0 failed, build 0 (docs_dev/20261009-classifiers-wave3-integration.md).

## Out of scope

Retry decisions (L0-03), response parsing (L0-05), metadata stripping inside `sanitizeProviderError` (L0-06).
