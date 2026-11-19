---
trdd-id: VQ0VEK3L
title: Ten miscellaneous Windows failures with no shared cause
column: todo
status: tasked
created: 2026-11-18T16:54:16+0100
updated: 2026-11-20T00:28:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: spike
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:54:16+0100
parent-trdd: 61EINA10
---

# Ten miscellaneous Windows failures with no shared cause

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G12. Failures: 10. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G12 (10 failures; log lines of run 44305836777: 3807 classifier-profile; 3819 config-dir-hermetic; 3838, 3857, 3876 default-output-dir; 3895, 3918, 3939 diff-scope; 5871 server-commands; 7353 local-decider; mark ? misc, no shared cause): Different assertions per row (expected 0 to be greater than 0; expected false to be true; list mismatches; contain-text). diff-scope rows follow git warnings LF will be replaced by CRLF at 3625-3627 ✓; the link is ?. 5871 "stopped the calibration runner pid 65..." (SIGTERM semantics ?). 7353 binary as regular file on PATH not detected (exec-bit ?).
Failing tests (group, log line, file, test name, first error line; log order):
- G12 log 3807 src/classifier-profile.test.ts :: classifier spend gate (D2) > PF-09: no classify or browse code path consults allow_paid_models :: AssertionError: expected 0 to be greater than 0
- G12 log 3819 src/config-dir-hermetic.test.ts :: hermetic suite: getConfigDir() isolation > resolves under /tmp (config.ts's own allowlist root) during the suite :: AssertionError: expected false to be true // Object.is equality
- G12 log 3838 src/default-output-dir.test.ts :: defaultOutputDir resolution (Issue #5) > anchors on CLAUDE_PROJECT_DIR verbatim + reports/llm-externalizer (git presence at the root is ignored) :: AssertionError: expected false to be true // Object.is equality
- G12 log 3857 src/default-output-dir.test.ts :: defaultOutputDir resolution (Issue #5) > falls back to CLAUDE_PROJECT_DIR when it isn't a git repo :: AssertionError: expected false to be true // Object.is equality
- G12 log 3876 src/default-output-dir.test.ts :: defaultOutputDir resolution (Issue #5) > old name LLM_OUTPUT_DIR is silently ignored (only LLM_EXT_OUTPUT_DIR is read) :: AssertionError: expected false to be true // Object.is equality
- G12 log 3895 src/diff-scope.test.ts :: resolveDiffScope — delegated to a real git repo > workspace mode: modified + untracked files, each with hunks :: AssertionError: expected [ …(2) ] to deeply equal [ 'b.ts', 'untracked.ts' ]
- G12 log 3918 src/diff-scope.test.ts :: resolveDiffScope — delegated to a real git repo > commit mode: one commit vs its parent, hunk carries git's enclosing-function context :: AssertionError: expected [ Array(1) ] to deeply equal [ 'a.ts' ]
- G12 log 3939 src/diff-scope.test.ts :: resolveDiffScope — delegated to a real git repo > range mode: merge-base '...' semantics over the two fixture commits :: AssertionError: expected [ Array(1) ] to deeply equal [ 'a.ts' ]
- G12 log 5871 src/broker/server-commands.test.ts :: server-status and server-stop > a runner still alive 60 s after SIGTERM is named with its pid, never reported as stopped (review of 2411e6dc, finding D) :: AssertionError: expected 'stopped the calibration runner pid 65…' to contain 'the calibration runner pid 6516 did n…'
- G12 log 7353 src/classifiers/l2/local-decider.test.ts :: singletonInstalledAt — the production install check, over a temp HOME and PATH > the binary as a regular file on PATH is installed :: AssertionError: expected false to be true // Object.is equality

## Approval log

- 2026-11-18T16:54:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:32+0100 — column → todo by main-agent@llm-externalizer-plugin.
