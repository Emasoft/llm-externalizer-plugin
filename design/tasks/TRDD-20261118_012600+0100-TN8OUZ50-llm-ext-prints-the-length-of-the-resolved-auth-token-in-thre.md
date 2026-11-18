---
trdd-id: TN8OUZ50
title: llm-ext prints the length of the resolved auth token in three places
column: blocked
status: tasked
created: 2026-11-18T01:26:00+0100
updated: 2026-11-18T02:02:22+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T01:26:00+0100
blocked-by: [TYSKX72I]
pre-block-column: testing
blocker-probe: test -f design/tasks/TRDD-20261117_224108+0100-TYSKX72I-split-scripts-llm-ext-src-index-ts-so-the-ubs-taint-analysis.md
blocker-holds-if: exit-0
---

# llm-ext prints the length of the resolved auth token in three places

Measured 2026-11-18: every llm-ext command prints "[llm-externalizer] Auth: token resolved (73 chars)" on stderr (seen in llm-ext --version and session-summary output). The length of a secret narrows what it can be and is not needed: the line exists so users can see the env var was picked up. Fix: print no length at all, on three lines: the startup line "Auth: token resolved" (scripts/llm-ext/src/index.ts, the startup IIFE), the settings summary line "Auth: set" or "Auth: NOT SET" (scripts/llm-ext/src/config.ts), and the per-profile auth line "(set)" or "(NOT SET)" (scripts/llm-ext/src/index.ts). The frozen copy under scripts/llm-ext/benchmark-fixtures/ is left as it is. Docs (docs/setup-and-configuration.md, docs/tool-use-cases.md) mention the line without the length, so they need no change. Done when: tsc and eslint are clean and a build prints all three lines with no length.

## Approval log

- 2026-11-18T01:26:00+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress

2026-11-18T01:48:38+0100: the fix is written and checked (tsc 0, eslint 0, scratch build shows the three lines with no length on the token-present branch) but NOT committed: the pre-commit ubs scan of index.ts plus config.ts stopped at the taint work limit (partial, exit 2, 0 critical) and the hook blocked the commit. The diff is saved at reports_dev/auth-line/TN8OUZ50-uncommitted-20261118_014317+0100.patch (worktree, gitignored). Unblocks when TRDD-TYSKX72I gives index.ts a commit path.

## Blocker probe

Run blocker-probe with the working directory set to the directory that holds design/ (builds_dev/dev-after-14.3.0 in the llm-externalizer checkout), not the repo root: from the repo root it exits 1 and the block reads as released. No trddgrep verb runs blocker-probe, and trddgrep validate says it never executes one.
