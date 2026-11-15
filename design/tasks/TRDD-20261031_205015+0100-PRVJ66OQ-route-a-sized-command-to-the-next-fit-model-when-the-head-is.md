---
trdd-id: PRVJ66OQ
title: Route a sized command to the next fit model when the head is unfit for its task kind
column: backburner
status: tasked
created: 2026-10-31T20:50:15+0100
updated: 2026-10-31T20:50:28+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-31T20:50:15+0100
---

# Route a sized command to the next fit model when the head is unfit for its task kind

## Approval log

- 2026-10-31T20:50:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Description

Parent: TRDD-1OOAH3LD (P7, commit 6339f84f).
P7 fails a sized command when the head model of a local profile is unfit for the command task kind (fact, aggregate or bug); design/specs/local-calibration-design.md section 6 says the command should route to the next fit model of the profile instead.
Acceptance: the command uses the first model in profile order whose record is ok and fit for the kind, names each skipped model on stderr, and fails naming every model with its reason only when none is fit; mass scouting (06bb2f96) already does this for scouting and is the model to follow.
