---
trdd-id: 1Y9UK5MK
title: Governor, config and calibration tests rely on POSIX modes, signals and ps
column: todo
status: tasked
created: 2026-11-18T16:54:15+0100
updated: 2026-11-20T00:28:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:15+0100
parent-trdd: 61EINA10
---

# Governor, config and calibration tests rely on POSIX modes, signals and ps

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G9,G10. Failures: 13. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G9 (8 failures; log lines of run 44305836777: 6347-6473 governor.test.ts; mark ✓ 4, ? 4): 6348: expected 438 to be 448 (mode bits 0o666 vs 0o700 ✓). 6462: TypeError: Unknown signal: SIGSTOP ✓. 6474-6475: Command failed: ps -o stat= -p 334 and ps: unknown option -- o ✓ (the product also calls ps, same text at 385 ✓). EISDIR on a governor state tmp file at 394 ✓. ? 6366, 6385, 6404 (expected [Function] to throw an error; chmod read-only dirs not refused) and 6423, 6442 (pid start-time checks return undefined).
- G10 (5 failures; log lines of run 44305836777: 3788 backup-exclusive; 5669 migrate-141; 5688 pick-lock; 5891 calibration; 7452 l2/report E52; mark ✓ 2, ? 3): 3788 and 5891: expected 438 to be 384 ✓ (0o666 vs 0o600). ? Read-only or unwritable config dirs are not refused: 5669 expected true to be false ✓; 5688 child stdout {"ok":true,"changed":true} ✓; 7452 expected [Function] to throw an error ✓.
Failing tests (group, log line, file, test name, first error line; log order):
- G10 log 3788 src/backup-exclusive.test.ts :: backups never overwrite > a new backup is created with mode 0600 :: AssertionError: expected 438 to be 384 // Object.is equality
- G10 log 5669 src/benchmark/migrate-141.test.ts :: migrateSettingsTo141 — price-ceiling-into-paid > only the top-level ceiling present, and the config dir is read-only (write fails): settingsLevelErrors reports the write-failure message, not a false 'twice' claim, and the file is left byte-identical :: AssertionError: expected true to be false // Object.is equality
- G10 log 5688 src/benchmark/pick-lock.test.ts :: withSettingsWriteLock — real concurrency, real processes (TRDD P5 review finding 5) > (e) an unwritable config dir (ENOENT/EACCES on both mkdir and the stat that follows it) throws after the wait bound instead of spinning forever (row 76, TRDD-90DM5YHO) :: AssertionError: child stdout: {"ok":true,"changed":true}
- G10 log 5891 src/calibration/calibration.test.ts :: calibration record (spec section 7) > writeRecord is atomic and 0600, and refuses an invalid record without writing :: AssertionError: expected 438 to be 384 // Object.is equality
- G9 log 6347 src/governor/governor.test.ts :: the state directory > is created private, with its parents :: AssertionError: expected 438 to be 448 // Object.is equality
- G9 log 6366 src/governor/governor.test.ts :: the state directory > an unwritable dir is refused, not passed through :: AssertionError: expected [Function] to throw an error
- G9 log 6385 src/governor/governor.test.ts :: the state directory > an unwritable parent is refused too :: AssertionError: expected [Function] to throw an error
- G9 log 6404 src/governor/governor.test.ts :: real processes > a change the directory refuses is not lost and reaches the next caller as an error, never as a crash :: AssertionError: expected [Function] to throw an error
- G9 log 6423 src/governor/governor.test.ts :: real processes > a live pid with the wrong start time is reclaimed, and one with the right start time is not :: AssertionError: expected undefined to be truthy
- G9 log 6442 src/governor/governor.test.ts :: real processes > the start string of this process agrees with what the check reads :: AssertionError: expected undefined to be '' // Object.is equality
- G9 log 6461 src/governor/governor.test.ts :: real processes > a live head that stops polling loses its turn after 10 s, and still has a place when it resumes :: TypeError: Unknown signal: SIGSTOP
- G9 log 6473 src/governor/governor.test.ts :: real processes > a zombie reads as alive, and is passed like any stopped head :: ps: unknown option -- o [decisive line (first error: Error: Command failed: ps -o stat= -p 334)]
- G10 log 7452 src/classifiers/l2/report.test.ts :: prepareReportDir > E52: an existing read-only directory fails before any write :: AssertionError: expected [Function] to throw an error

## Approval log

- 2026-11-18T16:54:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:26+0100 — column → todo by main-agent@llm-externalizer-plugin.
