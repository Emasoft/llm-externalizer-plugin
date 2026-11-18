---
trdd-id: PNU8XECB
title: Intermediate llm-ext output defaults to reports_dev, final reports stay in reports
column: complete
status: archived
created: 2026-11-15T01:23:15+0100
updated: 2026-11-18T16:31:43+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T01:23:15+0100
implementation-commits: [07164c03, 1e7811da]
---

# Intermediate llm-ext output defaults to reports_dev, final reports stay in reports

Owner correction relayed by perch-17 on 2026-11-15, verbatim: "why it should ignore reports/llm-externalizer?? nothing under reports should be ignored. if its a intermediate artifact or partial report, it must been saved into the gitignored reports_dev/llm-externalizer instead." Agent decision: background and maintenance output (automatic benchmark comparisons, partial runs, per-chunk files, logs, raw model output) defaults to <root>/reports_dev/llm-externalizer/<sub>/; a final report the user asked for stays in <root>/reports/llm-externalizer/<sub>/. Fix consumer-guidelines.md section 4 (drop the advice to gitignore reports/llm-externalizer), the installed rule rules/use-llm-externalizer.md default-path line, README, and the default output-dir resolution per writer class; LLM_EXT_OUTPUT_DIR and -o keep overriding.

## Approval log

- 2026-11-15T01:23:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-11-15 01:30 owner definition relayed by perch-17, verbatim: "reports only contains final reports and complete/merged reports. while reports_dev contains intermediate artifacts and partial reports or temporary checklists." Rule: a run that merges per-file or per-chunk results into one finished report writes the merged report to reports/llm-externalizer/<sub>/; per-file pieces, partial runs, checklists and scratch go to reports_dev/llm-externalizer/<sub>/. Content routing from ~/.claude/rules/reports-and-memory.md: private data, machine or harness state, tool or environment configuration go to reports_dev even when complete. INTERPRETATION pending owner confirmation (perch-17 reading, not owner words): automatic benchmark comparisons of llm-ext's own model pool count as tool configuration and go to reports_dev. The body's earlier agent decision is superseded by this line.
2026-11-15 01:31 USER directive (supersedes the relayed definitions above), verbatim: "reports folder is always git tracked and sanitized from secrets before committing. reports folder only contains final reports and complete/merged reports, or updated checklists with some progress tracking. while reports_dev is always gitignored and it contains intermediate artifacts, partial reports or temporary scratch files. In general the *_dev version of a folder is the gitignored one, the other without the _dev suffix is git tracked. Make sure to instruct the subagents to save their temporary or scratch files in the *_dev folders, and the final files in the other ones." Scope ordered: update all rule files and skills/tools.
2026-11-15 02:15 routing landed in 07164c03 and 1e7811da. OPEN: owner to confirm model-pool benchmark/health/arrivals/auto-replace/update-all reports as reports_dev (agent interpretation); fix-found-bugs init-run scratch still writes to reports/ (deferred); 775 untracked files now visible under reports/ need sanitize-reports and a per-file move to reports_dev before any add; auto-replace-cli and settings_edit routing tests run in the pre-push suite after npm run build.
2026-11-15T08:38:51+0100 FOLLOW-UP owed: the USER write-roots rule of 2026-09-18 (recorded on TRDD-DS6OM3KX, Standing USER rules) lists <project>/reports/llm-externalizer/ but not <project>/reports_dev/llm-externalizer/, which the 2026-11-15 routing now writes. The 2026-11-15 USER directive (intermediate output to reports_dev) is the newer instruction. Agent reading, NOT a USER quote: the write-roots list should gain reports_dev/llm-externalizer/; record that as a dated agent-reading note on DS6OM3KX and leave the 2026-09-18 USER text untouched, and sweep code and tests that enforce the write roots (grep scripts/llm-ext/src for write-root or allowed-root checks, benchmark/index.ts:3059-3072 history) before the pre-push suite.
- 2026-11-16T20:16:02+0100 — column → human_review by main-agent@llm-externalizer-plugin. shipped in v14.3.0; full npm test green in v14.4.0; OPEN owner confirmation of which model-pool reports are intermediate (agent interpretation)
- 2026-11-18T16:31:43+0100 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met; reviewed by the main agent under the USER delegation of 2026-11-18.

## Notes

2026-11-18T15:52:36+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): Ruling Q1: confirmed, the llm-ext own model-pool reports (benchmark, health, arrivals, auto-replace, update-all) are intermediate output and stay in reports_dev/llm-externalizer (llm-ext own tool state; the USER rule routes tool and environment configuration and intermediate artifacts to reports_dev). Issue 18: decided no sanitizing inside llm-ext (owner rule 2026-11-15: reports are sanitized from secrets before committing; llm-ext never commits, so the pre-commit step is the gate, and a Node port or a shell-out of sanitize-reports would create a second source of truth or a hard dependency). The reply was posted and the issue closed on 2026-11-18: https://github.com/Emasoft/llm-externalizer-plugin/issues/18#issuecomment-6981707539 (read back with gh api). The 864 untracked files under reports/ in the main checkout are a separate task: TRDD-09RLEY2F. Evidence: triage B3.

## Acceptance

- [x] default output-dir resolution per writer class: intermediate output to <root>/reports_dev/llm-externalizer/<sub>/, final reports stay in <root>/reports/llm-externalizer/<sub>/, LLM_EXT_OUTPUT_DIR and -o keep overriding: commits 07164c03 and 1e7811da exist (pre-squash ids, not ancestors of the v14.3.0 tag; consumer-guidelines.md section 4 documents the split, the override and CLAUDE_PROJECT_DIR)
- [x] consumer-guidelines.md section 4 no longer advises gitignoring reports/llm-externalizer; the installed rule rules/use-llm-externalizer.md default-path line (line 10) and the README (line 128) state the reports and reports_dev split: read this run
- [x] fix-found-bugs init-run scratch writes to reports_dev (deferred item of note 2026-11-15 02:15): commit 06c438e0 (ancestor of tag v14.7.2), and CHANGELOG.md line 36 lists it under 14.7.2
- [x] reports_dev/llm-externalizer ignores itself in any project: commit b5ea3eeb (ancestor of tag v14.7.2)
- [x] owner confirmation of which model-pool reports (benchmark, health, arrivals, auto-replace, update-all) are intermediate: ruling Q1 of main agent 2026-11-18T15:52:36 (delegated by USER 2026-11-18; not an owner answer), they stay in reports_dev/llm-externalizer
