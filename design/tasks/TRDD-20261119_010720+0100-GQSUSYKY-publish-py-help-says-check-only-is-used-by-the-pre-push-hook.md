---
trdd-id: GQSUSYKY
title: publish.py help says --check-only is used by the pre-push hook but no hook calls it
column: backburner
status: tasked
created: 2026-11-19T01:07:20+0100
updated: 2026-11-19T01:07:20+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T01:07:20+0100
---

# publish.py help says --check-only is used by the pre-push hook but no hook calls it

Found by the main agent during the 14.7.3 publish runs, verified by reading the code 2026-11-19. scripts/publish.py:870 reads: `help="Run checks only (build, manifest, CPV) without publishing. Used by pre-push hook.",` (the --check-only argument, lines 867-871). No hook calls it: grep -n check-only over .githooks, hooks, .github, .claude-plugin and scripts/*.py,*.sh finds only publish.py (line 11 usage text, :868, :895) and a comment in scripts/llm-ext/src/test-hermetic-config.ts:11; the git hooks directory .githooks holds pre-commit, pre-merge-commit and pre-push, and pre-push only checks that publish.py is an ancestor of git push (it does not run --check-only). Done when: the help text names the real callers (or none), or the pre-push hook runs --check-only on purpose.

## Approval log

- 2026-11-19T01:07:20+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
