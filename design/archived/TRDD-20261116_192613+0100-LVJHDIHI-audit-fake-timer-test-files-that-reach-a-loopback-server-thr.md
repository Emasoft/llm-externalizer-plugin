---
trdd-id: LVJHDIHI
title: Audit fake-timer test files that reach a loopback server through the local governor
column: superseded
status: archived
created: 2026-11-16T19:26:13+0100
updated: 2026-11-16T20:16:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T19:26:13+0100
superseded-by: [71QRO9JL]
---

# Audit fake-timer test files that reach a loopback server through the local governor

Follow-up of TRDD-FC2TX9VU. The breaker test in provider/completion.test.ts hung because a send to 127.0.0.1 takes a local-governor lease whose retry poll waits on a setTimeout that the test had faked; a dead poller then hung every later loopback test in the file (measured 2026-11-16: 9 later tests timed out). The fix there switched the governor off in that test and resets the pollers in the file-level afterEach (resetGovernorPollersForTests in governor/client.ts). Not audited: the other test files that fake setTimeout, for example provider/http.test.ts, retry-clock.test.ts, local-fallback.test.ts, command-stop-sleep, scan-folder-http-failures, install-lock, session_summary driver, ping. For each, check whether it reaches 127.0.0.1 through chatCompletionWithRetry or fetchWithRetry429 while setTimeout is faked and the governor is on; if so apply the same two guards. Do not put the reset in the shared setup file: the governor test files run real concurrent lease waits.

## Approval log

- 2026-11-16T19:26:13+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T20:16:26+0100 — SUPERSEDED by main-agent@llm-externalizer-plugin. duplicate of the older 71QRO9JL; its content was appended there.
