---
trdd-id: CEBZRG4Y
title: classify-review CLI exits 1 on Windows
column: todo
status: tasked
created: 2026-11-18T16:54:16+0100
updated: 2026-11-26T19:56:51+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:16+0100
parent-trdd: 61EINA10
---

# classify-review CLI exits 1 on Windows

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G13. Failures: 9. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G13 (9 failures; log lines of run 44305836777: 6266, 6267, 6268, 6287, 6306, 6325, 6326, 6327, 6328 cli/classify-review-cli.test.ts; mark ✓ text, ? cause): expected 1 to be +0 (exit code 1 at classify-review-cli.test.ts:77, code ✓; the stderr check on line 76 passes ✓); expected 1 to be 3 (6306 ✓). ? The built CLI exits 1; its stderr is not in the log.
Failing tests (group, log line, file, test name, first error line; log order):
- G13 log 6266 src/cli/classify-review-cli.test.ts :: classify --estimate (built CLI) > --estimate after the verb: exit 0, the classify estimate text, no decisions request, no key :: AssertionError: expected 1 to be +0 // Object.is equality [shared: error printed after run; run ends at line 6268]
- G13 log 6267 src/cli/classify-review-cli.test.ts :: classify --estimate (built CLI) > --estimate after the verb, before the files: exit 0, the classify estimate text, no decisions request, no key :: AssertionError: expected 1 to be +0 // Object.is equality [shared: error printed after run; run ends at line 6268]
- G13 log 6268 src/cli/classify-review-cli.test.ts :: classify --estimate (built CLI) > --estimate before the group: exit 0, the classify estimate text, no decisions request, no key :: AssertionError: expected 1 to be +0 // Object.is equality
- G13 log 6287 src/cli/classify-review-cli.test.ts :: classify --estimate (built CLI) > --estimate between the group and the verb shows the group help and sends nothing :: AssertionError: expected 1 to be +0 // Object.is equality
- G13 log 6306 src/cli/classify-review-cli.test.ts :: classify --estimate (built CLI) > without --estimate the same command line needs the key (exit 3), so the test above proves the estimate skipped it :: AssertionError: expected 1 to be 3 // Object.is equality
- G13 log 6325 src/cli/classify-review-cli.test.ts :: classify ping (built CLI) > accepts the global flags: ["--quiet","classify","ping","--no-call"] :: AssertionError: expected 1 to be +0 // Object.is equality [shared: error printed after run; run ends at line 6328]
- G13 log 6326 src/cli/classify-review-cli.test.ts :: classify ping (built CLI) > accepts the global flags: ["classify","ping","--quiet","--no-call"] :: AssertionError: expected 1 to be +0 // Object.is equality [shared: error printed after run; run ends at line 6328]
- G13 log 6327 src/cli/classify-review-cli.test.ts :: classify ping (built CLI) > accepts the global flags: ["classify","ping","--no-call","--profile","cl"] :: AssertionError: expected 1 to be +0 // Object.is equality [shared: error printed after run; run ends at line 6328]
- G13 log 6328 src/cli/classify-review-cli.test.ts :: classify ping (built CLI) > accepts the global flags: ["--profile","cl","classify","ping","--no-call"] :: AssertionError: expected 1 to be +0 // Object.is equality

## Approval log

- 2026-11-18T16:54:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:29+0100 — column → todo by main-agent@llm-externalizer-plugin.

## Notes

2026-11-26T19:56:47+0100 Fixed on dev/after-14.3.0 by c8f56d69 (NODE_OPTIONS --import as a file URL). Investigation: reports_dev/windows-investigation/; plan FIX-PLAN.md. macOS: tsc, eslint and the 36 changed test files pass. Windows CI not yet run (needs a release candidate, blocked on the llama-server repair).
