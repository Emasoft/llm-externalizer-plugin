---
trdd-id: 7FBVLGFQ
title: classify commands warn about the key of the active text profile they never use
column: backburner
status: tasked
created: 2026-11-18T15:21:37+0100
updated: 2026-11-18T15:21:37+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:21:37+0100
---

# classify commands warn about the key of the active text profile they never use

Found 2026-11-18 in the TRDD-1L9VMEY7 live pass (reports_dev/1l9vmey7-check/20261118_051817+0100-live-pass-1470.md, addendum 2 items 6 and 10): the startup Auth line (scripts/llm-ext/src/index.ts, the startup IIFE near line 631) is computed from the ACTIVE TEXT profile, so a classify run on the local-only profile local-decision prints "Auth: $OPENROUTER_API_KEY is NOT set in the environment" with a warning sign about a key that run never uses; with active: local_llama it prints nothing. Split out of TRDD-TN8OUZ50, whose scope is the token length. Decide: skip the line for classify commands, or name the classifier profile it refers to.

## Approval log

- 2026-11-18T15:21:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
