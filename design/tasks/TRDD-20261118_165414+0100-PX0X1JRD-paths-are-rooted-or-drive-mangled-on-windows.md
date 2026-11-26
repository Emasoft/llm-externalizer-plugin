---
trdd-id: PX0X1JRD
title: Paths are rooted or drive-mangled on Windows
column: todo
status: tasked
created: 2026-11-18T16:54:14+0100
updated: 2026-11-26T19:56:50+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:14+0100
parent-trdd: 61EINA10
---

# Paths are rooted or drive-mangled on Windows

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G4. Failures: 4. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G4 (4 failures; log lines of run 44305836777: 4646 parallel-repair; 6625, 6637 transcript; 7422 regex-worker; mark ✓): Rooted or drive-mangled paths. esbuild "error: Could not resolve \tmp\llm-ext-parallel-repair-b5PCJM\child-entry.ts" (4648 ✓); esbuild "error: Could not resolve /D:/a/llm-externalizer-plugin/.../regex-worker.ts" (7424 ✓); transcript "ENOENT ... open D:\D:\a\llm-externalizer-plugin\...\transcript.ts" (6626, 6638 ✓).
Failing tests (group, log line, file, test name, first error line; log order):
- G4 log 4646 src/parallel-repair.test.ts :: parallel inline repair of one invalid marked section (TRDD-5Q79QZM7) > two real processes racing: exactly one regenerates and backs up, the other reports placeholder-present, original bytes survive :: error: Could not resolve "\\tmp\\llm-ext-parallel-repair-b5PCJM\\child-entry.ts" [decisive line (first error: Error: Build failed with 1 error:)]
- G4 log 6625 src/session_summary/transcript.test.ts :: readTranscript > streaming — never loads the whole file into memory > the implementation never imports a synchronous whole-file read (structural proof) :: Error: ENOENT: no such file or directory, open 'D:\D:\a\llm-externalizer-plugin\llm-externalizer-plugin\scripts\llm-ext\src\session_summary\transcript.ts'
- G4 log 6637 src/session_summary/transcript.test.ts :: readTranscript > streaming — never loads the whole file into memory > the stripped-output write path never buffers a joined string (structural proof) :: Error: ENOENT: no such file or directory, open 'D:\D:\a\llm-externalizer-plugin\llm-externalizer-plugin\scripts\llm-ext\src\session_summary\transcript.ts'
- G4 log 7422 src/classifiers/l2/regex-worker.test.ts :: needs build: the inline worker survives bundling > a bundled copy of regex-worker.ts, run from an unrelated directory, still times out a catastrophic regex and finds matches :: error: Could not resolve "/D:/a/llm-externalizer-plugin/llm-externalizer-plugin/scripts/llm-ext/src/classifiers/l2/regex-worker.ts" [decisive line (first error: Error: Build failed with 1 error:)]

## Approval log

- 2026-11-18T16:54:14+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:32+0100 — column → todo by main-agent@llm-externalizer-plugin.

## Notes

2026-11-26T19:56:47+0100 Fixed on dev/after-14.3.0 by 722e0b40 (fileURLToPath and os.tmpdir for esbuild entries and own-source reads). Investigation: reports_dev/windows-investigation/; plan FIX-PLAN.md. macOS: tsc, eslint and the 36 changed test files pass. Windows CI not yet run (needs a release candidate, blocked on the llama-server repair).
