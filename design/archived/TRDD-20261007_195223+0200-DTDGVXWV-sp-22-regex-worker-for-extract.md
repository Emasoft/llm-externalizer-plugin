---
trdd-id: DTDGVXWV
title: SP-22 Regex worker for extract
column: complete
status: archived
created: 2026-10-07T19:52:23+0200
updated: 2026-10-10T05:28:27+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:52:23+0200
implementation-commits: [0db9627e]
---

# SP-22 Regex worker for extract

Run the extract command's user regexes in a worker thread with a timeout, so a catastrophic pattern ends as `invalid_pattern` instead of hanging the CLI.

## Approval log

- 2026-10-07T19:52:23+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T05:06:00+0200 — column → dev by main-agent@llm-externalizer-plugin. SP-22 dispatched to a worker in parallel with C4-03 (no shared files except the vitest include entry, which the coordinator adds at commit)
- 2026-10-10T05:28:27+0200 — COMPLETE by main-agent@llm-externalizer-plugin. worker and E64 test proven in 0db9627e; DoD met as a pair with 5f282fff on one green run.

## Plan refs

§9 (`classify extract`: regex worker, jev-mcp `server.ts:1111-1286`); §12 E64; §16 SP table.

## Depends on

none

## Files

- the regex worker module and its test: to be listed at card start
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`

## Reuse

to be listed at card start

## Steps

1. read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (jev-mcp `server.ts:1111-1286`, the regex part); check the licence row from SEC-01 (D17).
2. implement a worker thread that runs one regex over the document and returns the matches (derived from done-when).
3. enforce a timeout: on expiry terminate the worker and report `invalid_pattern` (E64).
4. test with the corrected E64 input: `"a".repeat(40000)+" end"` against `(a+)+$`.
5. add the test file to the vitest include list (derived from done-when).
6. WHY comments at every non-obvious rule.

## Acceptance

- [x] worker thread + timeout
- [x] E64: extract: catastrophic regex, `"a".repeat(40000)+" end"` with `(a+)+$` → worker timeout → `invalid_pattern`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The extract spec that calls the worker (SP-09).
