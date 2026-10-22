---
trdd-id: XBAEW3R3
title: publish.py shellchecks gitignored .sh files under reports and fails check-only on a dev tree
column: backburner
status: tasked
created: 2026-10-21T20:10:08+0200
updated: 2026-10-21T20:10:08+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-21T20:10:08+0200
---

# publish.py shellchecks gitignored .sh files under reports and fails check-only on a dev tree

2026-10-21: publish.py --check-only on the release branch failed at shellcheck on reports/classifiers-probe/p01/probe.sh, a gitignored local scratch script (.gitignore:83 /reports/). This also breaks the pre-push hook on any dev tree that holds local scratch scripts. Fix: lint only git-tracked .sh files (git ls-files '*.sh').

## Approval log

- 2026-10-21T20:10:08+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
