---
trdd-id: PN84WC1L
title: A scan with failed files exits non-zero and never saves an error response as a report
column: todo
status: tasked
created: 2026-10-07T17:26:13+0200
updated: 2026-10-07T17:31:28+0200
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
npt: []
---

# A scan with failed files exits non-zero and never saves an error response as a report

## Issue item
Issue 16 item 3: 429s leave silent empty reports.

## Trace and status
PARTLY. 429 IS retried (provider/http.ts:110-230 fetchWithRetry429: 5 retries, 1s doubling to 30s cap, Retry-After floor), then completion.ts 3 more, then the file loop 3 more: about 31 s of waiting in total. Part A (window too short for a free per-minute cap) is delivered by TRDD-YG72CYY7. Part B open: scan-folder/core.ts:354,415,438 return isError only on abort; failed files are listed under FAILED: but a non-aborted run exits 0 (cli/main.ts exits 1 only on result.isError). Part C (inferred, needs reproducer): processFileCheck (index.ts:3277) gates only on empty or echo (response-gate.ts), never on resp.finishReason === error; chatCompletionWithRetry returns {content: SERVER ISSUE DETECTED ..., finishReason: error} from breaker paths (completion.ts:1001-1010,1162-1170,1400), non-empty text that can be written as a report.

## Acceptance
- [ ] any failed file gives exit 1 and a FAILED (n of m) block with each file's cause
- [ ] processFileCheck rejects finishReason error content instead of saving it
- [ ] real node:http test with a scripted 503 and a scripted 429 for some files shows the failed files in the summary and the exit code
- [ ] the card records that item 3 part A is delivered by TRDD-YG72CYY7

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:13+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Ordering

Lands after TRDD-YG72CYY7, which delivers its part A (the 5-minute 429 window); the 14.1.0 release order is strictly serial on src, so no npt link is needed.

## Step 1 (before any guard)

Reproduce item 3 part C first. Through the breaker path, using a local node:http server, show that the 'SERVER ISSUE DETECTED' text with finishReason error is written as a report. If it cannot be reproduced, record the attempt on this card and drop acceptance item (b) instead of adding an unproven guard.
