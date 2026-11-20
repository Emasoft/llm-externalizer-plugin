---
trdd-id: 2VZ3JGDH
title: governor 20 process test child exits 1 on Windows in run 44637570018 with stderr never captured
column: todo
status: tasked
created: 2026-11-20T01:02:39+0100
updated: 2026-11-20T01:26:59+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T01:02:39+0100
implementation-commits: [fcffd407]
---

# governor 20 process test child exits 1 on Windows in run 44637570018 with stderr never captured

Symptom: Windows CI run 44637570018 (v14.7.7, commit 63451b7b) failed 196 tests, run 44598923287 (14.7.6) failed 195. The one new failure is src/governor/governor.test.ts > real processes > 20 processes through acquire never exceed max_inferences, take turns, and end on their own, assertion at governor.test.ts:664 expect(codes).toEqual(Array(count).fill(0)): two of 20 child processes exited 1 (codes 6 and 7 of the list). It took 15145 ms. The test passed on Windows in runs 44598923287, 44481380800, 44444699567, 44425067928, 44305836777.

Finding 1 VERIFIED (import graph only): the changed 14.7.7 source files are not in the child's import graph. The child is the ENTRY bundle at governor.test.ts:524-557, which imports only ./client.ts (acquire, release, snapshot). An esbuild metafile of that bundle, rebuilt from git archive of commit 63451b7b with the test's own options (builtins and better-sqlite3 external, CJS shim banner, yaml bundled), lists 95 inputs and none of boot-settings.ts, benchmark/pick.ts, cli/main.ts or index.ts, the only src files changed between v14.7.6 and v14.7.7 besides tests. So 335e384e (boot-settings.ts re-read) and the Y7G1ZRBG window are excluded as a code path of the child; the cause of the exit 1 is NOT established. Limit: the metafile was built with the esbuild JS API outside vitest, not through the test's beforeAll. The full v14.7.6..63451b7b diff also holds setup-node v6.4.0 to v7.1.0 in ci.yml, a new test file boot-settings.test.ts (145 lines) added to vitest.config.ts, and edits to three other test files, so a load or timing change in the Windows run is not excluded; the setup-node bump and the new test file are unmeasured candidates, with no evidence tying either to a child exit code. governor/ itself has no change in that range.

Finding 2 (read part VERIFIED, directory part INFERRED): the child reads settings.yaml only through governor/settings.ts:56-58 (statSync plus readFileSync, read only, never writes), and test-hermetic-config.ts:34-40 sets LLM_EXT_CONFIG_DIR to an empty cfgiso-* dir when it is unset (ci.yml not checked for a preset value; governor.test.ts sets it only at line 246, in another test), so that read would be ENOENT, defaults.

Finding 3 VERIFIED: the children's stderr is not captured. governor.test.ts:608 spawns with stdio ignore,ignore,pipe and nothing reads or drains the stderr pipe; the exit codes are all the test keeps (governor.test.ts:613-619, 659-664). The CI log shows only the code diff, so the reason for exit 1 is unknown.

Hypotheses INFERRED, not shown, no one ranked above another: a child's acquire rejected with a GovernorDirError from (a) the lockless read path, governor/state.ts:236-244 readState and 225-232 readText (throws a dirError on any read error other than ENOENT, so a Windows read refused while another process renames state.json surfaces as a throw), or (b) governor/state.ts:283-284 writeState (writeFileSync temp then renameSync onto state.json) or from the lock mkdir at state.ts:249-256, because Windows refuses a rename or a mkdir while another of the 20 children (or the test's own 20 ms snapshot loop, governor.test.ts:647-655) has the file open; the ENTRY script has no catch, so the rejection ends the process with exit 1. No corroboration: 'a change the directory refuses...' and 'a live pid with the wrong start time...' also failed in the earlier Windows runs where this test passed (win-1475, win-1476 logs), so they do not link to this failure. Other causes not excluded: a stale-lock takeover race, spawn or EMFILE pressure under 20 children, load in the suite run. A load flake is the null alternative.

Not related to Y7G1ZRBG: that card is the boot re-read, which no child runs.

## Approval log

- 2026-11-20T01:02:39+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [x] governor.test.ts collects every child's stderr (drain the pipe at governor.test.ts:608) and prints it, with the exit code, when a child exits non-zero, so a failing run names the cause
- [ ] The cause of the exit 1 is named from a captured stderr, and then either fixed where the stderr points or recorded as a load flake with its evidence
- [ ] The 20 processes test passes on the next three Windows CI runs

## Notes

2026-11-20 correction: the test is absent from the 14.7.6 failure list by name (run 44598923287); for runs 44481380800, 44444699567, 44425067928 and 44305836777 only equal totals of 195 are known, plus two fail-title checks, so 'passed in five runs' is partly inferred. Only a failing Windows run will show the children's stderr; a passing run names nothing.
fcffd407 drains every child's stderr and prints index, code, signal and stderr of each failing child. By the worker's report, a scratch copy of the real test with child 3 forced to exit 1 printed the whole multi-line stderr; the main agent did not see that run.
