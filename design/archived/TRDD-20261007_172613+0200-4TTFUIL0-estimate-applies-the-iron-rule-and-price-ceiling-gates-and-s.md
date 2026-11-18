---
trdd-id: 4TTFUIL0
title: --estimate applies the IRON RULE and price ceiling gates and says so up front
column: published
status: archived
created: 2026-10-07T17:26:13+0200
updated: 2026-11-18T08:12:09+0100
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:13+0200
release-via: publish
target-release: 14.1.0
implementation-commits: [0a9e7836, 38a7e9a8]
---

# --estimate applies the IRON RULE and price ceiling gates and says so up front

## Issue item
Issue 16 item 1: --estimate ignores the IRON RULE.

## Trace and status
PARTLY. Moot for hand-listed models (59ba9351, connection.ts:96), open for auto-picked ones. cli/main.ts:774-779 calls estimateToolRun(tool.name, args, buildEstimateDeps()); estimate.ts never imports benchmark/validated.ts. assertModelValidated has callers only at provider/connection.ts:96, mass_scouting/scout.ts:254, mass_scouting/cli.ts:1371, security_scan/judge.ts:207. Same gap for the send-time price ceiling (connection.ts:112-130). Related: --profile free --estimate on an unpopulated default profile quotes slot glm-5.3-flash with expected ?, ceiling ? and no hint the profile is not populated.

## Acceptance
- [x] for a refused model, estimate prints WOULD BE REFUSED: IRON RULE ... Validate it: llm-ext-benchmark <flag> <model> --allow-paid-models-tests, and exits non-zero, before any cost line
- [x] validated, manual, local and ':free' models print the normal estimate
- [x] an unpopulated default profile says profile not populated yet instead of quoting a slot with unknown price
- [x] test with the real ledger files in a temp config dir, no fetch mock

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:13+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T05:26:46+0100 — column → complete by main-agent@llm-externalizer-plugin.
- 2026-11-18T08:12:09+0100 — column → publish by main-agent@llm-externalizer-plugin. shipped: implementation lines present in the v14.7.0 tree (content check 2026-11-18; the SHAs are pre-squash, so not tag ancestors)
- 2026-11-18T08:12:09+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. shipped: implementation lines present in the v14.7.0 tree (content check 2026-11-18; the SHAs are pre-squash, so not tag ancestors).

## Notes

2026-10-31: boxes 1-4 ticked. Commits 0a9e7836 and 38a7e9a8; test src/estimate-gates.test.ts passing on 2026-10-31. CLI verified WOULD BE REFUSED with exit 1 and nothing on stdout. Unpopulated profile refused by profileGateRefusal with its own wording. Box 4 evidence: the test uses a mkdtemp config dir and no fetch or vi mock.
