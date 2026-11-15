---
trdd-id: 6XMCY4ZE
title: Commit scripts/llm-ext/dist rebuilt from HEAD
column: complete
status: archived
created: 2026-11-04T14:11:24+0100
updated: 2026-11-14T01:02:33+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T14:11:24+0100
blocked-by: []
unblock-when: []
pre-block-column: todo
blocker-probe: git diff --quiet HEAD -- scripts/llm-ext/dist
blocker-holds-if: exit-nonzero
review-after: 2026-11-11
implementation-commits: [dd283255]
---

# Commit scripts/llm-ext/dist rebuilt from HEAD

## Goal

The committed scripts/llm-ext/dist is stale: a fresh build differs by 11411 insertions and 3877 deletions, and --stop_on_errors is absent from the committed dist. It cannot be committed from the main tree while another session holds an uncommitted dist rebuild there. Rebuild from HEAD and commit it.

## Acceptance

- [x] dist rebuilt from HEAD committed; built dist equals committed dist

## Notes
2026-11-04T14:27:17+0100 parked in backburner: the main-tree dist holds another session's uncommitted rebuild; resume when git diff --quiet HEAD -- scripts/llm-ext/dist exits 0. The blocker-probe field is documentation only.
2026-11-04T14:54:17+0100 Committed dist is further stale from 9fec6c04 on: main.ts readAllStdin now calls readAllFrom. Behaviour is identical: a clean git-archive export of 9fec6c04 built (exit 0) and, given an open brace on stdin, exits 1 with "cannot read the JSON input from stdin". 898c51e3 and bc9d1157 are test-only and do not change dist. Not rebuilt here, because dist is modified and uncommitted by another session. When this card resumes, build from a clean git archive HEAD export, never from the shared working tree: that tree holds another session's uncommitted source (governor help in main.ts, governor/settings.ts and more), which a build there would bundle into dist.
2026-11-14T01:40+0100 done in dd283255: the main tree held no uncommitted source (git status showed only the two dist files), so a build there is a build of HEAD; npm run build exit 0, output byte-identical (diff -r exit 0) to the dist built at 23:34 on 2026-11-13 and to the committed files. Checks: eslint exit 0; npm test batch 1 5924 passed, 1 failed (completion.test.ts:780 timing 5187 ms vs 5000 ms while a second full suite ran; alone 12/12 passed), batch 2 217 passed 2 skipped, batch 3 39 passed. Built with local node_modules, not a clean git archive export: npm ci cannot reproduce it while package-lock is out of sync (TRDD-NQMW9AK5).

## Approval log

- 2026-11-04T14:11:24+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-04T14:27:59+0100 — column → backburner. Cannot be worked while another session holds an uncommitted dist rebuild in the main tree.
- 2026-11-14T01:02:33+0100 — COMPLETE by main-agent@llm-externalizer-plugin. dist rebuilt from HEAD committed in dd283255; acceptance box ticked.
