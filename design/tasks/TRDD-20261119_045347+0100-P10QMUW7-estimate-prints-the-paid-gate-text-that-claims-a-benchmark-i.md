---
trdd-id: P10QMUW7
title: --estimate prints the paid gate text that claims a benchmark is running
column: backburner
status: tasked
created: 2026-11-19T04:53:47+0100
updated: 2026-11-19T04:53:47+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:53:47+0100
---

# --estimate prints the paid gate text that claims a benchmark is running

cli/main.ts:996-1005 (the --estimate branch) prints profileGateRefusal's message verbatim except for the free empty-pool case, which TRDD-CQSODQ78 rewrote because an estimate starts nothing. For the generated, never-benchmarked paid profile the gate returns paidBenchmarkInProgressMessage (dynamic-maintainer.ts:1305, text at :1412-1438): 'paid profile is not benchmarked yet and is being benchmarked now (typically ~15 minutes) — re-run this command when it finishes. Progress: <cfg>/default-profile-paid.log'. Under --estimate dispatch is never reached, so no benchmark and no detector start; a worker run (reports_dev/fp2saf4p-6910/, items i9 i9b i9c, 14.7.3 and HEAD) found no progress log and no process afterwards (one ps snapshot, weak runtime evidence; source evidence: main.ts:991 comment 'the real run is gated in dispatchCallTool, which this branch never reaches'). Fix: in the estimate branch, say what is true for the unpopulated paid case (nothing started; run the command once without --estimate to start the benchmark, then re-run --estimate), with a test. Open question to check while fixing: whether the REAL command starts the paid benchmark at all, since index.ts:4924-4962 starts a profile update only for reason empty-pool-refreshable and otherwise returns gate.message unchanged (the detector scheduled at :4923 runs after dispatch). Found while working TRDD-FP2SAF4P item 9.

## Approval log

- 2026-11-19T04:53:47+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
