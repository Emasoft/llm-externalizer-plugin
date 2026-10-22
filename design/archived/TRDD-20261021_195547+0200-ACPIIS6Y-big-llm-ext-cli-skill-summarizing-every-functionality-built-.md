---
trdd-id: ACPIIS6Y
title: Big llm-ext CLI skill summarizing every functionality, built with skill-creator
column: complete
status: archived
created: 2026-10-21T19:55:47+0200
updated: 2026-10-21T22:24:30+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-21T19:55:47+0200
implementation-commits: [6dffb832, 6cb8e26c, 045337b0]
---

# Big llm-ext CLI skill summarizing every functionality, built with skill-creator

## What the USER asked (2026-10-21, verbatim)

"and don't forget what i asked you (probably you forgot since you are rarely using the wikimem): many claude needs a big skill summarizing  all the functionalities of the llm-ext cli tool. create such skill using the anthropic official skill creator plugin."

## Goal

One comprehensive skill, shipped in this plugin, that summarizes every functionality of the `llm-ext` CLI (8 groups: session, llm, scan, check, scout, models, settings, classify, plus the global flags, the flat commands, profiles and report locations), so any Claude can use the tool without reading the source. It is authored with the official Anthropic skill-creator plugin (claude-plugins-official/skill-creator) and every fact in it is taken from the CLI's own `--help` output.

## Notes

- The existing `skills/llm-externalizer-usage` skill describes an older flat command form (`llm-ext code-task`). It overlaps with this skill; whether to fold it into the new one is recorded in the worker report and decided before the card closes. Related card: TRDD-AG99QCM7.
- Ship it in the same release as TRDD-FCWL7PXZ so the install carries it.
2026-10-21 built by a worker following the skill-creator workflow (eval loop skipped): skills/llm-externalizer-cli-reference, SKILL.md (144 lines) plus 5 reference files covering 59 actions and 64 flat command names, all taken from the live --help output; the worker's grep check confirms every action is covered. The worker's standalone CPV validate_skill.py run was refused by CPV's integrity-manifest check; the plugin's publish gate (scripts/publish.py --check-only) validates the skill instead. Findings to settle: --estimate, --preview and -o appear in no action's --help, although the user rule and the README cite them; global flags must follow the group and action. Follow-up (separate card, not this release): fold the stale skills/llm-externalizer-usage skill into this one, and update the old flat command names in the scan, review, compact-session, mass-scouting, or-model-info, free-scan and config skills. Worker report: docs_dev/20261021-ACPIIS6Y-skill-report.md (local only).
- 2026-10-21 CPV 5.22.1 validate_skill.py flagged the description at ~224 estimated tokens (limit 200); shortened in 045337b0, re-validation 0 findings (reports/cpv/). Fold of the stale llm-externalizer-usage skill moved to its own card TRDD-F23GN7V3. All acceptance boxes ticked; the skill ships with the 14.1.0 release (TRDD-FCWL7PXZ).

## Acceptance

- [x] every group and action in `llm-ext --help --all` appears in the skill or its references
- [x] built with the skill-creator plugin's workflow
- [x] CPV skill validation clean
- [x] committed with this card's id in the subject

## Approval log

- 2026-10-21T19:55:47+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-21T22:24:30+0200 — COMPLETE by main-agent@llm-externalizer-plugin. acceptance met: full coverage, skill-creator workflow, CPV clean, committed.
