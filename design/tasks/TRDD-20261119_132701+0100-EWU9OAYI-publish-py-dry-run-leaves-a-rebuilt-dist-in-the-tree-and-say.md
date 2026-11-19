---
trdd-id: EWU9OAYI
title: publish.py dry run leaves a rebuilt dist in the tree and says the tree is unchanged
column: todo
status: tasked
created: 2026-11-19T13:27:01+0100
updated: 2026-11-19T13:27:01+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T13:27:01+0100
---

# publish.py dry run leaves a rebuilt dist in the tree and says the tree is unchanged

publish.py validate (step 2, run_checks) runs npm run build, which rewrites the tracked scripts/llm-ext/dist files whenever they are stale against the source, and run_checks never restores them (lines 332-480 hold no git checkout, restore or stash). When run_checks then fails, publish.py prints "Working tree is unchanged — fix the issues and re-run" (line 944), which is false, and the pre-flight of the next run refuses the dirty tree; the comment at lines 933-937 also says the tree is guaranteed untouched. A CPV failure (line 946) or a passing dry run (return at line 992) leaves the same rebuilt files behind with no message (read from the code, not observed). Observed 2026-11-19 in the 14.7.6 attempt: the dry run at 96e0682e rebuilt dist/llm-ext.js and dist/benchmark.js (stale since the v14.7.5 release commit f0766476), failed one test, printed that line, and the real publish stopped at pre-flight with both files modified; b1f17f31 committed the rebuild to recover. Task: after validate (and at the dry-run or check-only exit) compare git status with the pre-flight result and name every tracked file the checks changed, instead of claiming the tree is unchanged; or build into a directory outside the tree. Acceptance: (1) a validate that changes tracked files ends with a message naming those files, never "Working tree is unchanged"; (2) a test runs the check with a stale dist and asserts that message.

## Approval log

- 2026-11-19T13:27:01+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
