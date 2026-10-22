---
trdd-id: ET4XHRHK
title: L2-14 Warnings and degraded records
column: complete
status: archived
created: 2026-10-07T19:22:50+0200
updated: 2026-10-10T00:52:41+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:50+0200
implementation-commits: [5ce0cf95, e8d7d255, 0421472e]
---

# L2-14 Warnings and degraded records

## Goal
One format for warnings and degraded records, used by classify and browse.

## Approval log

- 2026-10-07T19:22:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:52:31+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:52:36+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:52:41+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§3 (`l2/warnings.ts`), D1 (degraded, warning, `fallback` field).

## Depends on

L2-12 (TRDD-B3R1SCSX)

## Files

- `scripts/llm-ext/src/classifiers/l2/warnings.ts`
- `scripts/llm-ext/src/classifiers/l2/warnings.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

Read the code at card start.

## Steps

1. Define one warning record and one degraded record (with a `fallback` field per D1). (derived from done-when)
2. Both appear in the L2-12 envelope. (derived from done-when)
3. Classify and browse use the same constructors. (derived from done-when)

## Acceptance

- [x] one format for classify and browse
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 5ce0cf95 (first of four commits for L2-14, L2-13, L2-16, L2-11, in that order), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/warnings.ts (Warning {code,message,count?}, DegradedRecord {where,reason,fallback}, warning() and degrade()), l2/warnings.test.ts, l2/envelope.ts typed warnings and degraded, envelope.test.ts. Classify and browse share one format. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. OPEN ITEMS: input warnings are still plain strings; conversion to Warning records (codes invalid_utf8, secret_redacted) belongs to C4-01.

## Out of scope

The fallbacks themselves (C4-05, BR-11).
