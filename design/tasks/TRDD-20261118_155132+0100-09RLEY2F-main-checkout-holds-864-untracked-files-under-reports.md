---
trdd-id: 09RLEY2F
title: Main checkout holds 864 untracked files under reports/
column: backburner
status: tasked
created: 2026-11-18T15:51:32+0100
updated: 2026-11-18T15:51:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:32+0100
---

# Main checkout holds 864 untracked files under reports/

git status in the main checkout shows ?? reports/ with about 864 untracked files (count from the 2026-11-18 triage; re-count before acting; git ls-files reports prints 0). Per file decide: final report (stays in reports/) or intermediate (moves to reports_dev/ with a plain mv). Never run sanitize-reports in place on an untracked file (git cannot restore it, RULE 0); sanitize only the files about to be committed, after a backup copy, then git add by name. Work in the main checkout, not a worktree. Origin: TRDD-PNU8XECB (routing of intermediate llm-ext output to reports_dev shipped in 14.3.0). Size M.

## Approval log

- 2026-11-18T15:51:32+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
