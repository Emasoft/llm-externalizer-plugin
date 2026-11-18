---
trdd-id: NIEDC62V
title: Windows-invalid file names and a non-absolute etc-hosts path in tests
column: backburner
status: tasked
created: 2026-11-18T16:54:15+0100
updated: 2026-11-18T16:54:15+0100
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

# Windows-invalid file names and a non-absolute etc-hosts path in tests

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G6. Failures: 10. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G6 (10 failures; log lines of run 44305836777: 4850 path-shim; 6205, 6221, 6237, 6253 review-fixes; 7085, 7278, 7302, 7321, 7340 inputs; mark ✓ text, ? cause): "llm-ext: no such file: /etc/hosts" (6205, 7302 ✓); "no such file: ../../../../..." (6221 ✓); "no such file: \tmp\..." (6237 ✓); ENOENT ... col^Gor.ts (6253 ✓, control byte); ENOENT ... plain\[x] r?.txt (7340 ✓, question mark); ENOENT mkdir of a name with a double quote (4850 ✓); promise resolved instead of rejecting (7278 ✓); expected throw /Path traversal blocked/ got no such file (7085 ✓). ? /etc/hosts is not an absolute path on Windows, so the traversal guard never runs; control bytes, question marks and double quotes are invalid in Windows names.
Failing tests (group, log line, file, test name, first error line; log order):
- G6 log 4850 src/path-shim.test.ts :: installer: hooks/install-path-shim.sh > I13: a HOME path containing a double quote still yields valid one-line JSON :: Error: ENOENT: no such file or directory, mkdir 'C:\Users\RUNNER~1\AppData\Local\Temp\pshim-CIPkGV\ho"me'
- G6 log 6205 src/classifiers/review-fixes.test.ts :: major 1: the files a findings JSON names stay inside the current directory and the JSON directory > an absolute path outside every allowed directory is refused with a clear message and nothing is sent :: AssertionError: expected 'llm-ext: no such file: /etc/hosts' to contain 'outside the directories a findings fi…'
- G6 log 6221 src/classifiers/review-fixes.test.ts :: major 1: the files a findings JSON names stay inside the current directory and the JSON directory > a ../ path that climbs out of every allowed directory is refused with a clear message and nothing is sent :: AssertionError: expected 'llm-ext: no such file: ../../../../..…' to contain 'outside the directories a findings fi…'
- G6 log 6237 src/classifiers/review-fixes.test.ts :: major 1: the files a findings JSON names stay inside the current directory and the JSON directory > a symlink beside the JSON that points outside is refused with a clear message and nothing is sent :: AssertionError: expected 'llm-ext: no such file: \tmp\llm-ext-r…' to contain 'outside the directories a findings fi…'
- G6 log 6253 src/classifiers/review-fixes.test.ts :: major 1: the files a findings JSON names stay inside the current directory and the JSON directory > a path with an escape sequence and a control byte is printed without them :: Error: ENOENT: no such file or directory, open 'D:\tmp\llm-ext-rvw-8Y0Vj3\col^Gor.ts'
- G6 log 7085 src/classifiers/l2/inputs.test.ts :: readForJev named single input > E35: a path outside the allowed roots is refused by sanitizeInputPath :: AssertionError: expected [Function] to throw error matching /Path traversal blocked/ but got 'no such file: /etc/hosts'
- G6 log 7278 src/classifiers/l2/inputs.test.ts :: review fixes F1-F9 > F1: a file a glob reaches through a link to outside the roots is refused :: AssertionError: promise resolved "{ items: [], skipped: [], warnings: [] }" instead of rejecting
- G6 log 7302 src/classifiers/l2/inputs.test.ts :: review fixes F1-F9 > F5: every refusal of a named path is an InputError with the sanitizeInputPath message :: AssertionError: expected 'no such file: /etc/hosts' to match /Path traversal blocked\|Symlink reject…/
- G6 log 7321 src/classifiers/l2/inputs.test.ts :: review fixes F1-F9 > F6: a FIFO named as an input is refused before any read :: AssertionError: expected [Function] to throw error matching /not a regular file/ but got 'no such file: \tmp\llm-ext-inputs-wes…'
- G6 log 7340 src/classifiers/l2/inputs.test.ts :: review fixes F1-F9 > F9: file and directory names with spaces, non-ASCII characters and brackets are read, not globbed :: Error: ENOENT: no such file or directory, open 'D:\tmp\llm-ext-inputs-UfP3Bo\plain\[x] r?.txt'

## Approval log

- 2026-11-18T16:54:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
