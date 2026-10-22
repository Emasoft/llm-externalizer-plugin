---
trdd-id: 9FE4Q3H3
title: L2-13 Attention and strict-exit codes
column: complete
status: archived
created: 2026-10-07T19:22:45+0200
updated: 2026-10-10T00:52:56+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:45+0200
implementation-commits: [81eb2089, e8d7d255, 0421472e]
---

# L2-13 Attention and strict-exit codes

## Goal
Attention and `--strict-exit` exit codes that follow existing llm-ext exit conventions.

## Approval log

- 2026-10-07T19:22:45+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:52:47+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:52:51+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:52:56+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§3 (`l2/attention.ts`), §9 receipt paragraph (exit codes follow llm-ext conventions; qs mapping 3, 4, 5 kept where llm-ext has none), §9 (columns: `--strict-exit` attention).

## Depends on

L2-12 (TRDD-B3R1SCSX)

## Files

- `scripts/llm-ext/src/classifiers/l2/attention.ts`
- `scripts/llm-ext/src/classifiers/l2/attention.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`cli/main.ts` exit conventions (read it first).

## Steps

1. Read `cli/main.ts` and list llm-ext's existing exit codes.
2. Map attention results to exit codes under `--strict-exit`, reusing existing codes; the qs mapping (3 key or credits, 4 request rejected, 5 failed after retries) only where llm-ext has no code of its own.

## Acceptance

- [x] exit codes follow the existing llm-ext conventions
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 81eb2089 (second of the four commits L2-14, L2-13, L2-16, L2-11), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/attention.ts (exit codes: attention with --strict-exit 1, else 0; ClassifierError class 3 for auth, payment, key-limit; 4 for bad-request, not-found, too-large, context-overflow; 5 for rate-limited, unavailable, network, timeout, bad-response and in-flight-budget; Ctrl-C reuses 130), l2/attention.test.ts. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Note: llm-ext used only 0 and 1 before, so 3, 4, 5 collide with nothing; strict attention and a generic error both exit 1 and are told apart by stderr/stdout. OPEN ITEMS: none.

## Out of scope

Per-spec attention predicates (L3 specs), flag wiring (C4-09).
