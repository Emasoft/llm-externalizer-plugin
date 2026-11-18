---
trdd-id: 5KZJQ9N4
title: Five input-args failures on Windows have no known cause
column: backburner
status: tasked
created: 2026-11-18T16:54:15+0100
updated: 2026-11-18T16:54:15+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:15+0100
parent-trdd: 61EINA10
---

# Five input-args failures on Windows have no known cause

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G5b. Failures: 5. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G5b (5 failures; log lines of run 44305836777: 6002, 6030, 6099, 6155, 6180 (input-args); mark ?): First errors are object-shape or exit-code assertions, not id lists: 6002 expected object to match object; 6030 expected 5 to be 1; 6099, 6155, 6180 expected object to match object ✓. Not explained by the id family. Cause not determined.
Failing tests (group, log line, file, test name, first error line; log order):
- G5b log 6002 src/classifiers/input-args.test.ts :: assembleFileInput over real files > rank and find run in files mode (candidates / items); find refuses --lines :: AssertionError: expected { query: 'query', …(2) } to match object { query: 'query', mode: 'files', …(1) }
- G5b log 6030 src/classifiers/input-args.test.ts :: file options reach collectInputs end to end > an unreadable file is a one-line refusal, not a stack (a plain system error from the reader) :: AssertionError: expected 5 to be 1 // Object.is equality
- G5b log 6099 src/classifiers/input-args.test.ts :: rank --head and --all as spec flags (IN-03) > rank --keep-at still parses as a threshold in files mode: 0.9 keeps the 0.9325 candidate, 0.95 drops it (owed from IN-01) :: AssertionError: expected { rows: [ { …(5) } ], total: 1, …(1) } to match object { total: 1, …(1) }
- G5b log 6155 src/classifiers/input-args.test.ts :: label --labels / --labels-json and file inputs (IN-02) > a label with a space ("bug report,feature") is accepted (class ids are free text) and is sent as typed :: AssertionError: expected [ { …(11) } ] to match object [ { …(2) } ]
- G5b log 6180 src/classifiers/input-args.test.ts :: label --labels / --labels-json and file inputs (IN-02) > a chunked file takes the default-label no-vote rule (E117): chunks that say the default label do not outvote the one chunk with the finding :: AssertionError: expected [ { …(12) } ] to match object [ { …(2) } ]

## Approval log

- 2026-11-18T16:54:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
