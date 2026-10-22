---
trdd-id: RPLLP8CF
title: Scan summaries print token and cost totals
column: todo
status: tasked
created: 2026-10-07T17:26:14+0200
updated: 2026-10-07T17:31:30+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:14+0200
release-via: publish
target-release: 14.1.0
---

# Scan summaries print token and cost totals

## Issue item
Issue 16 smaller note: no token or cost totals at the end of a scan.

## Trace and status
OPEN. scan-folder/core.ts summaries (lines 342, 400, 421) carry counts only; no usage or cost field is aggregated.

## Acceptance
- [ ] SCAN COMPLETE shows summed tokens in/out and cost (0.0000 on a free profile) for scan_folder and the other per-file tools
- [ ] test with a recorded usage object from a real local server

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:14+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Ordering

Lands after TRDD-PN84WC1L: both edit the scan-folder/core.ts summary block.
