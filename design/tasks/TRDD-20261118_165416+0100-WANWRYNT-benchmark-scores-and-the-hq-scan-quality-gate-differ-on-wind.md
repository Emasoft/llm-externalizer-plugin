---
trdd-id: WANWRYNT
title: Benchmark scores and the hq-scan quality gate differ on Windows
column: backburner
status: tasked
created: 2026-11-18T16:54:16+0100
updated: 2026-11-18T16:54:16+0100
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

# Benchmark scores and the hq-scan quality gate differ on Windows

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G11b. Failures: 12. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G11b (12 failures; log lines of run 44305836777: 5608, 5627, 5650 hq-scan-quality; 6649, 6668, 6694 code-task bench-runner; 6713, 6985, 7004, 7023, 7035 scan-folder bench-runner; 7066 search-existing; mark ✓ assertion, ? cause): hq-scan: expect(r.pass).toBe(true) at hq-scan-quality.test.ts:93 ✓ and freeFitnessUnlocked expected true at line 198 ✓ (a quality gate, not a path). Bench-runner scores: expected 0.5 to be 1 (6649), expected +0 to be 1 (6985, 7066), expected 36 to be 3 (7004) ✓; 6713 received a non-empty list where [] was expected ✓. ? Cause not determined.
Failing tests (group, log line, file, test name, first error line; log order):
- G11b log 5608 src/benchmark/hq-scan-quality.test.ts :: hq-scan quality benchmark (addendum H part 2) > runs the REAL scan-folder pipeline over the golden corpus — one call per file decision :: AssertionError: expected false to be true // Object.is equality
- G11b log 5627 src/benchmark/hq-scan-quality.test.ts :: hq-scan quality benchmark (addendum H part 2) > a same-day inconclusive rerun never overwrites an earlier PASS row :: AssertionError: expected { pass: false, inconclusive: true } to deeply equal { pass: true, inconclusive: false }
- G11b log 5650 src/benchmark/hq-scan-quality.test.ts :: hq-scan quality benchmark (addendum H part 2) > an oracle pass records the unlock verdict under the CURRENT corpus hash :: AssertionError: expected false to be true // Object.is equality
- G11b log 6649 src/benchmark/code-task/bench-runner.test.ts :: runCodeAuditBenchmarkOnModel — hermetic, real pipeline + real scorer > a PERFECT model (names exactly the planted defects, silent on clean files) scores 1.0 and PASSES :: AssertionError: expected 0.5 to be 1 // Object.is equality
- G11b log 6668 src/benchmark/code-task/bench-runner.test.ts :: runCodeAuditBenchmarkOnModel — hermetic, real pipeline + real scorer > an API error on one case is recorded as a failure and scored as a MISS — the sweep never aborts :: AssertionError: expected [ …(7) ] to deeply equal [ Array(1) ]
- G11b log 6694 src/benchmark/code-task/bench-runner.test.ts :: runCodeAuditBenchmarkOnModel — hermetic, real pipeline + real scorer > scores the FREETEXT fallback when a model ignores the DEFECT: contract :: AssertionError: expected false to be true // Object.is equality
- G11b log 6713 src/benchmark/scan-folder/bench-runner.test.ts :: runScanFolderBenchmarkOnModel — hermetic, real pipeline + real scorer > drives the REAL pipeline: one LLM call per file per query, with the SERVER's prompt :: AssertionError: expected [ { …(3) }, { …(3) }, { …(3) }, …(33) ] to deeply equal []
- G11b log 6985 src/benchmark/scan-folder/bench-runner.test.ts :: runScanFolderBenchmarkOnModel — hermetic, real pipeline + real scorer > scores a perfect model 1.0 and PASSES it :: AssertionError: expected +0 to be 1 // Object.is equality
- G11b log 7004 src/benchmark/scan-folder/bench-runner.test.ts :: runScanFolderBenchmarkOnModel — hermetic, real pipeline + real scorer > ONE flaky file is recorded as UNSCORED, never aborts the sweep, and is TOLERATED :: AssertionError: expected 36 to be 3 // Object.is equality
- G11b log 7023 src/benchmark/scan-folder/bench-runner.test.ts :: runScanFolderBenchmarkOnModel — hermetic, real pipeline + real scorer > a SYSTEMIC outage cannot pass — the coverage floor turns it into 'no evidence' :: AssertionError: expected +0 to be close to 0.6666666666666666, received difference is 0.6666666666666666, but expected 0.000005
- G11b log 7035 src/benchmark/scan-folder/bench-runner.test.ts :: runScanFolderBenchmarkOnModel — hermetic, real pipeline + real scorer > accumulates cost from the reported token usage :: AssertionError: expected +0 to be close to 0.0396, received difference is 0.0396, but expected 5e-7
- G11b log 7066 src/benchmark/search-existing/runner.test.ts :: runSearchExistingBenchmarkOnModel — hermetic, real pipeline > scores a correct model perfectly across a case subset and accumulates cost from usage :: AssertionError: expected +0 to be 1 // Object.is equality

## Approval log

- 2026-11-18T16:54:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
