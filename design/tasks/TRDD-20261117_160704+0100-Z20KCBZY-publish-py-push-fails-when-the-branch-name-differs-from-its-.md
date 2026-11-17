---
trdd-id: Z20KCBZY
title: publish.py push fails when the branch name differs from its upstream
column: todo
status: tasked
created: 2026-11-17T16:07:04+0100
updated: 2026-11-17T16:07:04+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T16:07:04+0100
---

# publish.py push fails when the branch name differs from its upstream

STATE 2026-11-17: the 14.6.2 publish (reports_dev/release-next/publish-20261117_151603+0100.log) passed every check, then made release commit 0aaad3a7 and tags v14.6.2 and llm-externalizer--v14.6.2 locally, and failed at step 10: git push --follow-tags (scripts/publish.py:1265) refused with 'The upstream branch of your current branch does not match the name of your current branch' (branch dev/after-14.3.0 tracks origin/main; push.default unset, so simple). Remote unchanged (main 04d412ea, no v14.6.2 tag; git ls-remote). A manual git push origin HEAD:main was refused by .githooks/pre-push (only publish.py may push), correctly. The v14.6.1 publish from the same branch pushed with the same command; why it then succeeded is not known. Fix: publish.py pushes to the branch's upstream explicitly (resolve @{upstream}, git push --follow-tags <remote> HEAD:<branch>), with a WHY comment and a test. Then finish 14.6.2 without a destructive reset: read publish.py's existing-tag preflight (log line 357-360) to see whether a rerun can push the existing local release commit and tags, or whether it needs a new version.

## Approval log

- 2026-11-17T16:07:04+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
