---
trdd-id: FP2SAF4P
title: Dry-run flag docs and tests owed from TRDD-58CFBQHN
column: backburner
status: tasked
created: 2026-11-18T15:51:33+0100
updated: 2026-11-18T15:51:33+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:33+0100
---

# Dry-run flag docs and tests owed from TRDD-58CFBQHN

Owed after the TRDD-58CFBQHN dry-run flag work (B2 triage, 2026-11-18): (1) tests that place --estimate or --preview after -- on the flat and grouped path (cli/main.ts about :851 and :859; classify is already pinned by 87c34c1d); (2) classify.md --json rows are missing from most decision tables; (3) the launcher.ts text "--estimate is not available for classify yet" (about :189 and :204) misleads, because classify ping has no dry run; (4) the leftover wording "development build of commit 153fe531" in classify.md (about :24) and SKILL.md (about :151). Line numbers are from the triage; re-read before editing. Parent: TRDD-58CFBQHN. Size S.

## Approval log

- 2026-11-18T15:51:33+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
