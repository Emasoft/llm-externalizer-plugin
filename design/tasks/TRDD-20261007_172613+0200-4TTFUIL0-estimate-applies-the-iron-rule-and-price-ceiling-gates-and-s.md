---
trdd-id: 4TTFUIL0
title: --estimate applies the IRON RULE and price ceiling gates and says so up front
column: todo
status: tasked
created: 2026-10-07T17:26:13+0200
updated: 2026-10-07T17:26:22+0200
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
---

# --estimate applies the IRON RULE and price ceiling gates and says so up front

## Issue item
Issue 16 item 1: --estimate ignores the IRON RULE.

## Trace and status
PARTLY. Moot for hand-listed models (59ba9351, connection.ts:96), open for auto-picked ones. cli/main.ts:774-779 calls estimateToolRun(tool.name, args, buildEstimateDeps()); estimate.ts never imports benchmark/validated.ts. assertModelValidated has callers only at provider/connection.ts:96, mass_scouting/scout.ts:254, mass_scouting/cli.ts:1371, security_scan/judge.ts:207. Same gap for the send-time price ceiling (connection.ts:112-130). Related: --profile free --estimate on an unpopulated default profile quotes slot glm-5.3-flash with expected ?, ceiling ? and no hint the profile is not populated.

## Acceptance
- [ ] for a refused model, estimate prints WOULD BE REFUSED: IRON RULE ... Validate it: llm-ext-benchmark <flag> <model> --allow-paid-models-tests, and exits non-zero, before any cost line
- [ ] validated, manual, local and ':free' models print the normal estimate
- [ ] an unpopulated default profile says profile not populated yet instead of quoting a slot with unknown price
- [ ] test with the real ledger files in a temp config dir, no fetch mock

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:13+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
