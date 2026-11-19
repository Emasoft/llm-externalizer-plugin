---
trdd-id: MVT4DCHS
title: C4-07 classify ping
column: published
status: archived
created: 2026-10-07T20:00:28+0200
updated: 2026-11-19T20:40:38+0100
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:28+0200
implementation-commits: [4cb052e9]
---

# C4-07 classify ping

## Goal

`classify ping`: a free key check plus one noul call, with `--no-call` to skip the call.

## Approval log

- 2026-10-07T20:00:28+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T20:40:38+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped in v14.7.6, release commit 53a415e0, tag v14.7.6.

## Plan refs

§9 row `classify ping` (free `GET /api/v1/key` + one noul, or `--no-call`; attention: failure; injection n/a), §3 L4 (`classifiers/commands/ping.ts`).

## Depends on

C4-01 (TRDD-BUL4EEBP)

## Files

`scripts/llm-ext/src/classifiers/commands/ping.ts` (create); test file and vitest include entry: to be listed at card start.

## Reuse

Read the code at card start.

## Steps

1. Call `GET /api/v1/key` (free) through the L0 transport (derived from done-when).
2. Send one noul question unless `--no-call` is given.
3. Any failure is reported and exits non-zero (derived from §9 attention).

## Acceptance

- [x] free key check
- [x] one noul
- [x] `--no-call`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The generic runner (C4-01), `--estimate` (C4-08).

## Notes

T6F52GB8 audit 2026-11-19 (verifier VA, not re-read by the main agent): PARTLY. Done: all Acceptance boxes except DoD are met (ping.ts:52-57 checkKey GET, one askOne/callDecisions with PING_QUESTION, --no-call, non-zero exit); ping 11, ping-stop 10, ping-history 5 pass. Remaining: step 1, moving the key GET of ping.ts:52-57 into the l0 transport (l0/transport.ts exports only callDecisions), and DoD.
2026-11-19 main agent: step 1 done in 4cb052e9: the key GET moved into l0/transport.ts as fetchKeyUsage, with KEY_URL beside it; only usage, limit and limit_remaining leave L0, and ping.ts checkKey calls it. Boxes 1 to 3 met (key check through L0, one noul, --no-call); transport 39, ping 11, ping-stop 10, ping-history 5 pass, npx tsc --noEmit and npx eslint . --quiet exit 0 (main agent runs). This supersedes the Remaining line of the T6F52GB8 audit note. The DoD box waits for the full npm test at the 14.7.6 publish gate.
2026-11-19 main agent, correction to the note above: box 1 rests on the main agent read of the 4cb052e9 diff; boxes 2 and 3 (one noul, --no-call) rest on the T6F52GB8 audit reading of ping.ts by verifier VA, not on a main agent read.
2026-11-19T20:40:23+0100 main agent (written by worker): DoD box ticked after the 14.7.6 publish gate: reports_dev/publish/test.log of attempt 6 shows 6671 + 222 + 12 + 1 tests passed, 0 failed, with typecheck and lint logs clean; ping.test.ts, ping-stop.test.ts, ping-history.test.ts and l0/transport.test.ts are in vitest.config.ts; 4cb052e9 (TRDD id in its subject, no vi.mock or vi.spyOn in the diff) is an ancestor of 53a415e0 (merge-base exit 0). Shipped in v14.7.6.
