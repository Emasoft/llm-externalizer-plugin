---
trdd-id: WTKO255N
title: A timed-out fake-timer test in completion.test.ts hung the rest of the file
column: complete
status: archived
created: 2026-11-05T00:08:36+0100
updated: 2026-11-05T01:10:04+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T00:08:36+0100
implementation-commits: [46b88412]
---

# A timed-out fake-timer test in completion.test.ts hung the rest of the file

## Symptom

Run 3 of the full npm test (2026-11-04, commit ebeab4fd, clean scratch worktree): in scripts/llm-ext/src/provider/completion.test.ts the test "a transient 5xx streak trips the circuit breaker (60s, then 120s) ..." hit its own 30 s cap at 23:15:47 (1-minute load 81.30 at 23:16:41). The next two tests ("no request_options: the request body is exactly what it was before the feature" and "options set: caller max_tokens larger than the profile cap is lowered to the cap") each timed out at the 900 s test timeout; the third was still running when the worker was stopped by hand; 12 more never started. The rest of stage 1 passed: 308 files passed, 5 skipped.

## Cause (mechanism measured in a forced-hang analog)

The breaker test calls vi.useFakeTimers and restores real timers only in its own finally; vitest abandons a timed-out test body, so that finally does not run while the body stays stuck. Cascade experiment, 2026-11-05, same worktree, breaker test forced to hang right after vi.useFakeTimers, 3 tests selected: no reset -> both later tests time out (20 s cap); vi.restoreAllMocks() alone -> both time out; vi.useRealTimers() in the file-level afterEach, alone or with restoreAllMocks -> both pass. Limit: the forced hang comes before the first request, not mid-ladder as in run 3; durations are not comparable across variants (load 115-156, concurrent load, cause of the load not recorded).

## Fix

Add vi.useRealTimers() as the first statement of the file-level afterEach (completion.test.ts lines 44-58), with a WHY comment.

## Acceptance

- [x] the commit adds the reset with a WHY comment
- [x] a whole-file run of completion.test.ts in a clean worktree: every test other than the breaker test passes and the file finishes in minutes, not hours
- [x] tsc --noEmit in the clean worktree and eslint on the file exit 0
- [x] the next full npm test run shows no test in completion.test.ts other than the breaker test failing with "Test timed out in", and no unhandled error attributed to completion.test.ts; the result records whether the breaker test itself timed out, because only then does the run exercise the reset; otherwise the box confirms no regression only and containment rests on the forced-hang analog (the run is TRDD-YGF9YXF2; the breaker trigger is TRDD-5B4HPVKO)

## Known limits (not covered, not measured)

1. If the breaker test times out before it reaches vi.useFakeTimers, its abandoned body can install fake timers during the next test, which can then hang; the afterEach reset stops it there.
2. A body abandoned while waiting in stoppableSleep stays in the module-level wakers set; a later command stop can wake it, and its vi.advanceTimersByTimeAsync then runs with real timers ("Timers are not mocked"), possibly a run-level unhandled error.
3. No automated check pins the fix; the comment is the only guard.

## Notes

The breaker test stderr spy also stays installed after a timeout and hides later tests stderr (not fixed here). The stalled worker held two listening servers; one was expected; unexplained. testTimeout 900_000 in vitest.config.ts is what made a 30 s flake cost 15 min per later test; that file holds another session uncommitted edits and is not touched. Evidence (gitignored, this machine only): reports_dev/ygf9yxf2/20261104_235528+0100-run3-hang-diagnosis.md with its corrections 20261105_000427+0100-run3-hang-diagnosis-corrections.md, and 20261105_000420+0100-cascade-experiment.md. Related: TRDD-YGF9YXF2.
Related: TRDD-5B4HPVKO (the breaker test exceeding its 30 s cap under load), TRDD-71QRO9JL (audit of the other 8 fake-timer test files).
Box 2 (2026-11-05T00:15+0100): whole-file run of completion.test.ts in the wt-ci scratch worktree (ebeab4fd plus the fix; its dist files are locally rebuilt) passed 39 of 39 in 92.42 s at 1-minute load 7.38. The breaker test passed on its own, so the reset was not exercised in that run; that run loaded the earlier comment wording (same code). Containment was shown only by the forced-hang run on the final text: breaker test failed at 2000 ms, the two later tests passed. The no-reset outcome (later tests time out) comes from the earlier cascade experiment, a separate temporary edit.
Box 3 (2026-11-05T00:15+0100): tsc --listFilesOnly -p scripts/llm-ext/tsconfig.json in the wt-ci worktree lists src/provider/completion.test.ts (tsconfig include src/**/*, exclude node_modules and dist), so tsc --noEmit type-checks it; eslint on the file exited 0 (--quiet, --config scripts/llm-ext/eslint.config.mjs). Listing log: reports_dev/wtko255n/logs/tsc-listfiles.log.
Correction to commit 46b88412 message: of the 13 tests after the two 900 s timeouts, one was hanging when the run-3 worker was stopped by hand and 12 had not started; not all of them waited out a timeout. The message also calls the scratch worktree clean; its dist files were locally rebuilt.
Box 3 file state: the fix worker report (reports_dev/wtko255n/20261105_001323+0100-timer-reset-fix.md step 3) records that after undoing the forced-hang edits git diff showed exactly the 6 fix lines before tsc ran. Box 4 added after review: the card stays in testing until the next full run.
2026-11-05T01:12+0100 Box 4 met by run 4b (TRDD-YGF9YXF2): no "Test timed out in" line and no unhandled error anywhere in the log; completion.test.ts passed (inferred from counts, F4: the reporter prints no per-file pass lines). The breaker test did not time out, so the reset was not exercised and the box confirms no regression only; containment rests on the forced-hang analog.

## Approval log

- 2026-11-05T00:08:36+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-05T00:16:40+0100 — column → testing. fix committed 46b88412; all 3 acceptance boxes checked
- 2026-11-05T01:10:04+0100 — COMPLETE by main-agent@llm-externalizer-plugin. all four boxes met; known limits recorded; follow-ups TRDD-5B4HPVKO and TRDD-71QRO9JL.
