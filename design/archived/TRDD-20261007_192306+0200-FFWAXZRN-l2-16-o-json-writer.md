---
trdd-id: FFWAXZRN
title: L2-16 -o JSON writer
column: complete
status: archived
created: 2026-10-07T19:23:06+0200
updated: 2026-10-10T00:53:09+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:23:06+0200
implementation-commits: [090270d1, e8d7d255, 0421472e]
---

# L2-16 -o JSON writer

## Goal
Write the classify result as a JSON report to the `-o` directory, atomically.

## Approval log

- 2026-10-07T19:23:06+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:53:02+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:53:06+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:53:09+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

D10, §3 (`l2/report.ts`), §4; E52.

## Depends on

L2-12 (TRDD-B3R1SCSX)

## Files

To be listed at card start, plus its test file and `scripts/llm-ext/vitest.config.ts`.

## Reuse

`defaultOutputDir` (named in §3; read the code for its location at card start).

## Steps

1. Use the `-o` directory, or `defaultOutputDir` when omitted (done-when).
2. Write the same JSON as stdout, as a `.json` file with a timestamped name (D10).
3. Write atomically (done-when).
4. A directory that is not writable fails before any API call (E52).

## Acceptance

- [x] atomic write
- [x] `defaultOutputDir` used
- [x] timestamped name
- [x] E52: `-o` directory not writable → error before any API call
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 090270d1 (third of the four commits L2-14, L2-13, L2-16, L2-11), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/report.ts (prepareReportDir, writeReport, writeAtomic with temp-file cleanup, decision-name validation), l2/report.test.ts. Atomic temp+rename write, defaultOutputDir used, timestamped name, E52 pinned by tests (the read-only-dir test skips as root). build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Notes: prepareReportDir must be called before any API request; that call is C4-09 wiring. OPEN ITEMS: about 15 copies of the timestamp helper exist in the package, none importable without booting the CLI (a cleanup outside this plan); the decision-name regex is repeated from catalog/index.ts.

## Out of scope

The envelope content (L2-12), flag wiring (C4-09).
