---
trdd-id: 97FOZOO2
title: Installed llm-ext rejects classify ping that the source and skill document
column: published
status: archived
created: 2026-11-04T10:30:50+0100
updated: 2026-11-16T15:14:27+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:30:50+0100
implementation-commits: [263e13b2]
---

# Installed llm-ext rejects classify ping that the source and skill document

Found by the TRDD-Q2VTMG4P audit on 2026-11-04: the installed llm-ext reports 14.2.0 and rejects classify ping (unknown action), while scripts/llm-ext/src/classifiers/commands/ping.ts exists, package.json says 14.1.2, and skills/llm-externalizer-cli-reference/references/classify.md documents ping. Find out which build the installed binary came from, whether ping is released or unreleased, and fix the install or the docs accordingly; do not delete the ping docs before knowing. Check the classify --estimate note at the same time.

## Approval log

- 2026-11-04T10:30:50+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T10:02:33+0100 — column → testing by main-agent@llm-externalizer-plugin. docs match the installed 14.3.0 help
- 2026-11-16T15:14:27+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. docs fix 263e13b2 shipped in v14.3.1; skill docs match the installed 14.3.x help.

## Notes

2026-11-16T10:02:32+0100 DONE by the main agent: 16 lines in 5 skill docs now say ping and the classify group ship in 14.3.0 (263e13b2). Checked on the installed 14.3.0 with a throwaway HOME: ping --help lists --no_call; filter --help lists --estimate, not --preview; requirements --help lists --context. Other stale next-release markers in consumer-guidelines.md (L3, L5, L16, L31, L38, L43, L71, L73, L89) are outside this card.
- [x] 2026-11-16 acceptance derived from the card text: the docs and the installed build agree on classify ping, the classify group and the --estimate note (263e13b2, shipped in v14.3.1)
