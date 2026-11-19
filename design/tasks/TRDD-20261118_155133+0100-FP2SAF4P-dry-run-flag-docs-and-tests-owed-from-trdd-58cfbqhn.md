---
trdd-id: FP2SAF4P
title: Dry-run flag docs and tests owed from TRDD-58CFBQHN
column: dev
status: tasked
created: 2026-11-18T15:51:33+0100
updated: 2026-11-19T04:12:49+0100
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
- 2026-11-19T04:12:49+0100 — column → dev by main-agent@llm-externalizer-plugin. items 1, 3 and 4 in progress (worker, 2026-11-19)

## Notes

2026-11-19T04:12:44+0100 carried from the archived TRDD-58CFBQHN STATE OWED list (main agent, 2026-11-19; the 58CFBQHN closing line said the whole list moved here, but this card held only items 1-4). Items 5-10, each to be re-checked at HEAD before work, since some may be stale after the 14.3.0-14.7.4 releases: (5) uncut-row and duplicate-row checks for the 14 classify decision commands other than filter (filter is pinned by cdf751f9 and ebeab4fd); (6) 'sends nothing' and 'no API key needed' for --estimate in classify.md (opening paragraph and the Output paragraph) and SKILL.md are unmeasured: the tests show only that no decisions request is sent; (7) builds not named at classify.md (about lines 459, 466, 483), requirements-pipeline.md (about line 46) and the boolean-flag paragraph of classify.md; (8) the publish-time doc rewrites: commit ids 153fe531 and 9e036052 in classify.md lines 3 and 5, the 14.2.0 availability notes (classify.md lines 5, 25, 27, 432, the ping Release line, requirements-pipeline.md line 38), the 'in no release yet' notes and the ping routing-row release note in SKILL.md, and a recheck of README line 117; (9) the llm cluster --estimate refusal was never shown on the built CLI with a paid profile; (10) classify ping --no_call (or --no-call) not measured on a shipped build (exit 0, no decision request).
