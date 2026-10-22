---
trdd-id: CWQOWEHO
title: L0-02 callDecisions request building
column: complete
status: archived
created: 2026-10-07T18:47:36+0200
updated: 2026-10-09T23:11:12+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T18:47:36+0200
implementation-commits: [f52cdd01]
---

# L0-02 callDecisions request building

## Goal
`callDecisions` builds and sends one request with the right headers, redirect policy, key-in-body refusal and body cap, per §7.

## Approval log

- 2026-10-07T18:47:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-09T23:11:12+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:11:12+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-09T23:11:12+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan.

## Plan refs

§3 L0 (signatures: `callDecisions`, `GlobalFetch`); §7 (Seam, Request, Body); E02, E08, E14; D21.

## Depends on

L0-01 (TRDD-NL788NGR), L0-10 (TRDD-0Z0L6IPP)

## Files

- `scripts/llm-ext/src/classifiers/l0/transport.ts`
- `scripts/llm-ext/src/classifiers/l0/transport.test.ts`
- `scripts/llm-ext/vitest.config.ts` (include entry)

## Reuse

`safeReadText` (`src/safe-body.ts:20`), called with 1,000,000 as the cap. Other reuse: read the code at card start.

## Steps

1. Use the `GlobalFetch` seam returning a real `Response`; never the header-less `FetchImpl`, never `realFetch` (free-rotation wrapped).
2. Request with `redirect: "error"` and headers `Authorization: Bearer`, `Content-Type`, `HTTP-Referer: https://github.com/Emasoft/llm-externalizer-plugin`, `X-OpenRouter-Title: llm-externalizer`.
3. Refuse before sending if the serialized body contains the resolved key (exact string only).
4. Read the body with `safeReadText(res, 1_000_000)`; a larger body is `bad-response` (too large).
5. WHY comments on `redirect: "error"` and the key-in-body refusal. (derived from done-when)

## Acceptance

- [x] E02: Body larger than 1 MB → `bad-response` (too large)
- [x] E08: 3xx redirect → error (`redirect: "error"`)
- [x] E14: API key text inside state or questions → refused before send
- [x] the four headers are sent
- [x] `redirect:error` set
- [x] key-in-body refusal
- [x] 1 MB body cap
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-09: committed f52cdd01 — l0/transport.ts callDecisions, 9 tests (fail when stubbed). Imports OPENROUTER_ATTRIBUTION_HEADERS (the step L0-11 left). Endpoint URLs are a placeholder map for L0-09. Whole package after the wave, run by the coordinator: npm test 210 files passed / 4 skipped, 3349 tests passed / 5 skipped / 0 failed; tsc, eslint . --quiet and build 0 per the fixing worker.

## Out of scope

Retry loop (L0-03), response parsing (L0-05), endpoint URL selection (L0-09), the attribution constant (L0-11).
