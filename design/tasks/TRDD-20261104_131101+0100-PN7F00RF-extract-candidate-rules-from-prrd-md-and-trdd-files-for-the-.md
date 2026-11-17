---
trdd-id: PN7F00RF
title: Extract candidate rules from PRRD.md and TRDD files for the duplicate and update check
column: backburner
status: tasked
created: 2026-11-04T13:11:01+0100
updated: 2026-11-17T15:14:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-04T13:11:01+0100
---

# Extract candidate rules from PRRD.md and TRDD files for the duplicate and update check

Gap of capability C5 of TRDD-Q2VTMG4P, found by the review of 49dfb148. The requirements-pipeline skill compares a new phrase only with candidate rules the caller already extracted. Missing: extracting the rules of a real PRRD.md (lines like "- **G7.4** — text") and of TRDD files into candidates, and a pre-filter when there are more than the 250 candidates classify find accepts in json mode (classify find in files mode, searching a file line by line, was not run). TRDD-LFTQCFUX is the separate gap of a single duplicate / updated version / new verdict.

## Approval log

- 2026-11-04T13:11:01+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-17T15:14:05+0100: parent skills card TRDD-Q2VTMG4P is archived (complete). When this card ships, update skills/llm-externalizer-cli-reference/references/requirements-pipeline.md (and classify.md where the command is documented) yourself; no live card tracks the C1 to C5 map any more.
