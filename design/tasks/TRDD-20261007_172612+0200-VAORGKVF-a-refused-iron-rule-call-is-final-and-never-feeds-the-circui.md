---
trdd-id: VAORGKVF
title: A refused IRON RULE call is final and never feeds the circuit breaker
column: todo
status: tasked
created: 2026-10-07T17:26:12+0200
updated: 2026-10-07T17:26:26+0200
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: user
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T17:26:12+0200
release-via: publish
target-release: 14.1.0
npt: [YG72CYY7]
---

# A refused IRON RULE call is final and never feeds the circuit breaker

## Issue item
Issue 16 item 2: a refused IRON RULE run does not fail fast.

## Trace and status
PARTLY (mechanism confirmed by reading, not reproduced). connection.ts:96 throws the IRON RULE not-validated error. In chatCompletionWithRetry (provider/completion.ts around 1060-1160) payment is null, it is not isPriceCeilingRefusal and not deterministic4xx (regex covers only 402/403/404/410), so recordServiceFailure() runs and the same model is retried up to MAX_TRUNCATION_RETRIES=3 with checkServiceHealthOrWait(). Five consecutive failures trip the breaker, which sleeps 60s, 120s, 350s (completion.ts:868-947). classifyError (index.ts:1985) has no rule for the message (SERVICE_LEVEL_STATUS_RE at index.ts:1915 needs API error NNN), so the file loop retries 3 times (index.ts:2227-2250, scan-folder/core.ts:276-308) and the batch aborts only after 3 consecutive failures. Siblings already fixed: price-ceiling refusal (da3a18bf), deterministic 4xx (f7ecaa9b, 613ba685). Since 59ba9351 (D3b) hand-listed models skip the gate (connection.ts:96), so it stays reachable for auto-picked models and for mass_scout / security_scan judges (mass_scouting/scout.ts:254, security_scan/judge.ts:207). Overlap: TRDD-YG72CYY7 does not cover this refusal.

## Acceptance
- [ ] the IRON RULE sentence is excluded from recordServiceFailure and from the same-model retry, next to isPriceCeilingRefusal in completion.ts
- [ ] classifyError returns unrecoverable for it, also when wrapped in ProfileExhaustedError
- [ ] real test: 20-file scan_folder with an unvalidated auto-picked model exits 1 in under 5 s, zero breaker waits, zero model-retry lines
- [ ] the open question in the issue correction comment (were refused requests retried) is answered in this card with the trace above

Source: GitHub issue 16 (owner-filed, 2026-10-03), verified at HEAD e4a927d2 on 2026-10-07; part of the 14.1.0 release (TRDD-WBZJRSQB).

## Approval log

- 2026-10-07T17:26:12+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
