---
trdd-id: MI0UJQF1
title: Opt-in line-numbered file input so reports cite exact lines
column: publish
status: tasked
created: 2026-11-18T16:25:41+0100
updated: 2026-11-19T02:15:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T16:25:41+0100
implementation-commits: [6e79df85]
release-via: publish
---

# Opt-in line-numbered file input so reports cite exact lines

GitHub issue 16 item 6. 2026-11-18T16:25:40+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): the default stays unnumbered (token cost, byte-exact excerpts); an opt-in flag that prefixes line numbers is planned here.

## Acceptance

- [x] the opt-in flag that prefixes line numbers to file input
- [x] a test for the flag
- [x] the docs line for the flag

## Approval log

- 2026-11-18T16:25:41+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T02:15:06+0100 — column → publish by main-agent@llm-externalizer-plugin. implemented and verified in 6e79df85; ships in 14.7.4

## Notes

2026-11-19T02:14:40+0100 main agent: implemented in commit 6e79df85 (flag line_numbers on llm ask, scan folder and scan quality; tests in scan-pipeline.test.ts, estimate.test.ts, cli/launcher.test.ts; docs rows in scan-and-check.md, session-and-llm.md, cli-conventions.md). cli/grouped-help-shape.test.ts needs the built CLI and runs at the build step before the 14.7.4 publish. Not covered by a test: the robust-path forwarding (max_retries greater than 1) and the fileLineCount error branch.
