---
trdd-id: A5J6E4JB
title: Windows runner lacks sqlite3, lsof and /bin/sh that tests call
column: todo
status: tasked
created: 2026-11-18T16:54:13+0100
updated: 2026-11-20T00:28:28+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:13+0100
parent-trdd: 61EINA10
---

# Windows runner lacks sqlite3, lsof and /bin/sh that tests call

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G2. Failures: 25. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G2 (25 failures; log lines of run 44305836777: 4660-5052 path-shim (21); 6490 sqlite3; 7372-7410 lsof (3); mark ✓ sqlite3 and lsof; ? path-shim): sqlite3: "sqlite3 is not recognized as an internal or external command" (6492 ✓). lsof: "spawn ... lsof ENOENT" (7379, 7398, 7411 ✓). path-shim: all 21 first errors are "expected null to be 0/1/127" from spawnSync("/bin/sh") at path-shim.test.ts:148 (code ✓): status null. ? The runner has no /bin/sh.
Failing tests (group, log line, file, test name, first error line; log order):
- G2 log 4660 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I1: sh -n passes on both the wrapper and the installer hook :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4679 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I4: fresh install writes the shim, exits 0, and reports it in one JSON line :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4698 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I5: a second run with unchanged bytes is a silent no-op :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4717 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I6: an older own shim (marker kept, bytes changed) is refreshed to the source bytes :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4736 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I7: a foreign regular file at the target is left untouched :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4755 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I8: a dangling symlink at the target is left untouched :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4774 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I9: a directory at the target is left untouched :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4793 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I10: installing to a dir not on PATH mentions it in the message :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4812 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I11: LLM_EXT_NO_PATH_SHIM=1 disables the hook entirely :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4831 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I12: a read-only ~/.local/bin fails loudly on the first stderr line :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 4862 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I14: a missing source script fails with an `llm-ext:`-prefixed error :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 4881 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W1 (V4): the registry-recorded install wins over an unrecorded, executable one :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4900 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W2 (V5): no llm-externalizer key in the registry fails with found 0 of 0 :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 4919 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W3 (V6): two user-scope records fails with found 2 :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 4938 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W4 (V7): a recorded but non-executable bin fails with no runnable CLI :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 4957 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W5 (V8): node missing from PATH fails with status 127 :: AssertionError: expected null to be 127 // Object.is equality
- G2 log 4976 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W6 (V9): CLAUDE_CONFIG_DIR is preferred over HOME for the registry lookup :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 4995 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W7 (V10): a session PATH match wins over the registry without ever reading it :: AssertionError: expected null to be +0 // Object.is equality
- G2 log 5014 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W8 (V11): a non-executable session bin fails without ever reading the registry :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 5033 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W9 (V13): a v1-shaped registry record fails with unexpected format, no raw TypeError :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 5052 src/path-shim.test.ts :: wrapper: path-shim/llm-ext > W10: a missing registry file fails with cannot read :: AssertionError: expected null to be 1 // Object.is equality
- G2 log 6490 src/mass_scouting/cli.test.ts :: runMassScoutCli — Phase C3 chain > end-to-end chain reuses runScoutJob and restores buckets :: 'sqlite3' is not recognized as an internal or external command, [decisive line (first error: Error: Command failed: sqlite3 'C:\Users\RUNNER~1\AppData\Local\Temp\cli-test-1795005722555-549bofmb3p6\scout.db' "SELECT classifier_bucket FROM file_short_id LIMIT 1")]
- G2 log 7372 src/classifiers/l2/local-decider.test.ts :: listenersOf > stderr output with exit 3 rejects, carrying the exit code and stderr :: AssertionError: expected [Function] to throw error matching /exit 3.*boom/ but got 'lsof failed (spawn error ENOENT: spaw…'
- G2 log 7391 src/classifiers/l2/local-decider.test.ts :: listenersOf > stderr output with exit 1 rejects too (a warning on exit 1 is a retryable cannot-list) :: AssertionError: expected [Function] to throw error matching /exit 1.*warn/ but got 'lsof failed (spawn error ENOENT: spaw…'
- G2 log 7410 src/classifiers/l2/local-decider.test.ts :: listenersOf > exit 1 with no output is an empty map (lsof's own 'nothing matched') :: Error: lsof failed (spawn error ENOENT: spawn C:\Users\RUNNER~1\AppData\Local\Temp\llm-ext-lsof-FZEF95\lsof ENOENT)

## Approval log

- 2026-11-18T16:54:13+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:28+0100 — column → todo by main-agent@llm-externalizer-plugin.
