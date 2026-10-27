---
trdd-id: CBOTP0DY
title: Child-process tests fail intermittently under machine load
column: backburner
status: tasked
created: 2026-10-07T13:19:18+0200
updated: 2026-10-23T07:15:19+0200
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T13:19:18+0200
---

# Child-process tests fail intermittently under machine load

## Approval log

- 2026-10-07T13:19:18+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

2026-10-07 investigation (report reports/llm-ext-release/20261007_131813+0200-profile-chain-402-flake.md): on the tree before b22bfae8, 4 of 7 full runs failed, each with a different set of failing tests, and reruns of the same seed passed or failed differently; the current tree was clean in 7 runs. Failures were mostly CLI child-process symptoms: exit code null, empty stderr, truncated JSON, 5 s and 15 s timeouts, and background-update counts of 0 where 1 was expected (profile-chain-402 Row 102, free-pool).
Likely cause, not yet proven: tests that spawn the CLI and wait on detached children with fixed timeouts are sensitive to machine load (a concurrent test suite from another session may have overlapped; not checked). Not seed-bound, so not test order.
Next step: record load (uptime) per run and repeat under controlled load to confirm; then raise the affected timeouts or replace fixed waits with readiness polling, per file.
Caveat: the 7-vs-7 comparison is confounded (the earlier tree ran later, under /private/tmp, with a symlinked node_modules, load unrecorded); only "the symptom also occurs before b22bfae8" is established.
Before raising any timeout: rerun both trees under identical conditions (both outside /tmp, each with its own node_modules, load logged per run, runs alternated).
2026-10-23 recurrence: under load average 70-146 the background-update count symptom (expected 1, got 0) reappeared in profile-chain-402 (two full runs, a different test each time) and in empty-pool-wait D2 (one of four sequential runs). Both read the count after a fixed wait. Seen while verifying 1e5adabe (TRDD-YG72CYY7), whose change cannot reach these tests.
