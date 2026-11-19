---
trdd-id: IQQQC98L
title: Tests still on 127.0.0.1 port 1 that mean a refused backend move to a refused port
column: todo
status: tasked
created: 2026-11-19T09:51:39+0100
updated: 2026-11-19T10:42:47+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T09:51:39+0100
---

# Tests still on 127.0.0.1 port 1 that mean a refused backend move to a refused port

After 354a9bbf (TRDD-3XKBS1YX) a url on a fetch-blocked port such as 1 stops at once with a bad-port verdict. About a dozen test files still use 127.0.0.1:1 as an unreachable backend; list them with grep -rnE on the pattern 127.0.0.1:1 followed by a non-digit under scripts/llm-ext/src. Port 1 never produced ECONNREFUSED (node gives no code for it), so these tests never covered the refused-connection path; they pass on the stop path. For each test: read what it asserts. If it means a refused connection, move it to a refused port (LOCAL_TEST_URL in test-helpers.ts, port 29871, or closedPortUrl in classify-failure.test.ts) and check it still passes alone. If it means a blocked port, keep port 1 and add a comment saying so. Size S.

## Approval log

- 2026-11-19T09:51:39+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-19 main agent: done in 55269f3b: the 40 port-1 sites in 25 files were classified by reading each test; local-bench.test.ts and profile-flag-and-output-dir.test.ts moved to refused port 29871, test-helpers.ts HELP_TEST_SETTINGS_YAML kept on port 1 with a comment, the rest left (bad-port tests and urls never connected); per-file runs pass (commit body). Waits for the full npm test at the 14.7.6 publish gate.
2026-11-19 main agent, correction to the note above: the classification of the 40 sites is the worker reading (reports_dev/iqqqc98l/), and these tests pass on either port, so they do not prove refused-port behaviour by themselves (55269f3b body).
