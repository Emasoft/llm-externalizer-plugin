---
trdd-id: LFTQCFUX
title: classify preset that says duplicate, updated version or new for a rule against existing rules
column: todo
status: tasked
created: 2026-11-04T10:29:26+0100
updated: 2026-11-17T15:13:53+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T10:29:26+0100
---

# classify preset that says duplicate, updated version or new for a rule against existing rules

Gap G2 of TRDD-Q2VTMG4P (capabilities C3 and C5). classify find (find.ts:13-30) ranks the nearest rules and says whether the phrase exists, and classify compare (compare.ts:27-31) only says same_fact, contradicts or different_facts for two passages given as JSON. No command returns the three outcomes the user's pipeline needs: duplicate, updated version of rule X, or new. Add a preset or spec (for example a label preset with classes duplicate, updated_version, new, fed the candidate rule found by find) that reads rules from a file such as PRRD.md or TRDD files, and test it on the user's loading-screen example.

## Approval log

- 2026-11-04T10:29:26+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

Code line numbers were reported by a read-only audit on 2026-11-04 and are not re-read; confirm them at card start. When this ships, update the requirements-pipeline reference of TRDD-Q2VTMG4P.
2026-11-04T13:22:52+0100 the skill page skills/llm-externalizer-cli-reference/references/requirements-pipeline.md step 2b documents the current two-command workaround (classify label per candidate rule plus a reading rule) and calls the single command a gap without naming this card; update that paragraph when this card ships.
2026-11-17T15:13:50+0100: parent skills card TRDD-Q2VTMG4P is archived (complete). When this card ships, update skills/llm-externalizer-cli-reference/references/requirements-pipeline.md (and classify.md where the command is documented) yourself; no live card tracks the C1 to C5 map any more.
