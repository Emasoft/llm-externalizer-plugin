---
trdd-id: Z3YW19WC
title: Tests compare POSIX path forms where Windows returns drive paths
column: todo
status: tasked
created: 2026-11-18T16:54:14+0100
updated: 2026-11-26T19:56:49+0100
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

# Tests compare POSIX path forms where Windows returns drive paths

Child of TRDD-61EINA10 (parent link only, on purpose). Source: reports_dev/windows-ci-triage/20261118_143238+0100-report-v3.md (sections 2 and 6), Windows CI run 44305836777 (v14.7.2: 195 failed of 6574 tests in 42 of 353 files). Windows stays experimental (README.md:15, 16719d1d).
Groups: G3,G11a,G14. Failures: 20. Marks of the report: a first error line is seen in the log; a cause marked with a question mark is unverified.
Cause lines of the report group table (verbatim):
- G3 (13 failures; log lines of run 44305836777: 5727-5839 report-dir (8); 5855 settings-resolution; 6574 scout-accuracy-ledger; 6609 security_scan/report; 7436 l2/report; 7471 writeReport; mark ✓ 12, ? 7471): Expected POSIX-form path, received Windows form. 5727: expected "\tmp\fake-project-root\reports_dev\ll..." to be "/tmp/fake-project-root/reports_dev/ll..." ✓; same family at 5855, 6574, 6609. 7436: expected "D:\tmp\llmext-report-5Lq3NF\default" to be "\tmp\llmext-report-5Lq3NF\default" ✓. 7471 is "expected false to be true" at report.test.ts:50 (startsWith); ? same family.
- G11a (4 failures; log lines of run 44305836777: 5589 build-report-path; 5708 populate-default-profile; 6590 core-report-routing; 7047 scan-folder dataset; mark ✓ assertion, ? cause): expected false to be true at build-report-path.test.ts:57 (startsWith join(fakeRoot, ...) ✓). 5708, 6590, 7047 show the same assertion shape ✓. ? Same path-form family as G3, not proven.
- G14 (3 failures; log lines of run 44305836777: 6505, 6531, 6553 mass_scouting/mcp-tools; mark ✓ text, ? cause): expected ... to contain reports_dev/llm-externalizer/... ✓. The received text is cut in the log, so the path form is not confirmed (?).
Failing tests (group, log line, file, test name, first error line; log order):
- G11a log 5589 src/benchmark/build-report-path.test.ts :: buildReportPath (C9 write-roots sweep) > routes the non-isolated default under <root>/reports_dev/llm-externalizer/benchmark/, not <root>/reports/benchmark/ directly :: AssertionError: expected false to be true // Object.is equality
- G11a log 5708 src/benchmark/populate-default-profile.test.ts :: paid sweep — per-call daily-spend booking (P5 §2.5 requirement 1/2) > fix-queue 29: buildReportPath routes an isolated run's report under LLM_EXT_CONFIG_DIR, never under process.cwd()'s reports/benchmark/ :: AssertionError: expected false to be true // Object.is equality
- G3 log 5727 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > nests the sub-dir under <mainRoot>/reports_dev/llm-externalizer/, not <mainRoot>/reports/ directly :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5743 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > uses a distinct sub-dir per caller-supplied name :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5759 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > pins scan-folder-benchmark (scan-folder/index.ts) to <mainRoot>/reports_dev/llm-externalizer/<sub> :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5775 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > pins code-task-benchmark (code-task/index.ts) to <mainRoot>/reports_dev/llm-externalizer/<sub> :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5791 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > pins search-existing-benchmark (search-existing/index.ts) to <mainRoot>/reports_dev/llm-externalizer/<sub> :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5807 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > pins check-specs-benchmark (check-specs/index.ts) to <mainRoot>/reports_dev/llm-externalizer/<sub> :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5823 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > pins text-tools-benchmark (text-tools/index.ts) to <mainRoot>/reports_dev/llm-externalizer/<sub> :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5839 src/benchmark/report-dir.test.ts :: benchmarkSubReportDir (C9 write-roots sweep) > pins security-triage-benchmark (security-triage/index.ts) to <mainRoot>/reports_dev/llm-externalizer/<sub> :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G3 log 5855 src/benchmark/settings-resolution-failfast.test.ts :: update-all report path (review of 43e3694, S4) > nests under <mainRoot>/reports_dev/llm-externalizer/update-all/ :: AssertionError: expected '\tmp\fake-project-root\reports_dev\ll…' to be '/tmp/fake-project-root/reports_dev/ll…' // Object.is equality
- G14 log 6505 src/mass_scouting/mcp-tools.test.ts :: dispatchMassScoutTool — check_model_health (TRDD-828238b5 A2) > checks the active profile's model offline and returns a summary + report path :: AssertionError: expected 'Model health — profile \'t\' — 2026-1…' to contain 'reports_dev/llm-externalizer/model-he…'
- G14 log 6531 src/mass_scouting/mcp-tools.test.ts :: dispatchMassScoutTool — discover_new_models (TRDD-828238b5 A4) > first run seeds the snapshot and returns a report path :: AssertionError: expected 'New model arrivals — 2026-11-18T12:44…' to contain 'reports_dev/llm-externalizer/model-ar…'
- G14 log 6553 src/mass_scouting/mcp-tools.test.ts :: dispatchMassScoutTool — check_tool_replacements (TRDD-828238b5 A7-P3) > runs no benchmark on a healthy ledger, writes a report, returns its path :: AssertionError: expected '9 tool(s) checked, 0 degraded, 0 repl…' to contain 'reports_dev/llm-externalizer/auto-rep…'
- G3 log 6574 src/mass_scouting/scout-accuracy-ledger.test.ts :: scout-accuracy ledger (D4) > lives in its OWN file — never security-triage-results.json :: AssertionError: expected 'D:\tmp\scout-ledger-test-tv2Da6\scout…' to contain '/tmp/scout-ledger-test-tv2Da6'
- G11a log 6590 src/scan-folder/core-report-routing.test.ts :: runScanFolder report routing (TRDD-PNU8XECB) > mode 2: per-file pieces go to reports_dev (INTERMEDIATE), the merged report to reports (FINAL) :: AssertionError: expected false to be true // Object.is equality
- G3 log 6609 src/security_scan/report.test.ts :: resolveReportDir > uses an explicit absolute output_dir verbatim, else <mainRoot>/reports/llm-externalizer/security_scan :: AssertionError: expected '\root\reports\llm-externalizer\securi…' to be the same path with forward slashes (the log quotes its POSIX form, an absolute path that CPV refuses in shipped files) // Object.is equality
- G11a log 7047 src/benchmark/scan-folder/dataset.test.ts :: the corpus > is scanned from src/, so the provenance README is never fed to the model as an 11th file :: AssertionError: expected false to be true // Object.is equality
- G3 log 7436 src/classifiers/l2/report.test.ts :: prepareReportDir > uses defaultOutputDir() when -o is omitted :: AssertionError: expected 'D:\tmp\llmext-report-5Lq3NF\default' to be '\tmp\llmext-report-5Lq3NF\default' // Object.is equality
- G3 log 7471 src/classifiers/l2/report.test.ts :: writeReport > writes exactly the given text to a timestamped .json file and leaves no temp file :: AssertionError: expected false to be true // Object.is equality

## Approval log

- 2026-11-18T16:54:14+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:34+0100 — column → todo by main-agent@llm-externalizer-plugin.

## Notes

2026-11-26T19:56:47+0100 Fixed on dev/after-14.3.0 by 73fc1b7e (expected report paths built with node:path). Investigation: reports_dev/windows-investigation/; plan FIX-PLAN.md. macOS: tsc, eslint and the 36 changed test files pass. Windows CI not yet run (needs a release candidate, blocked on the llama-server repair).
