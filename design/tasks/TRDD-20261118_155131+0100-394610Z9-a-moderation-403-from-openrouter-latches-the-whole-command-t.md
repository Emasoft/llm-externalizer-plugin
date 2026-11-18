---
trdd-id: 394610Z9
title: A moderation 403 from OpenRouter latches the whole command to local as a refused key
column: backburner
status: tasked
created: 2026-11-18T15:51:31+0100
updated: 2026-11-18T15:51:31+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:51:31+0100
---

# A moderation 403 from OpenRouter latches the whole command to local as a refused key

KEY_REFUSED_RE = /API error 40[13]\b/ (scripts/llm-ext/src/remote-fallback.ts:20) matches any 403, including an OpenRouter moderation or guardrail 403, so the whole command latches to the local fallback under the text "API key was refused". Narrow the 403 case to a refused key (a 403 that carries moderation metadata is not one); keep 401 as is. Test with a real node:http server, no mock. Source: TRDD-WSPV40Y5 card note F6 (from docs, not measured). Size S (under 50 lines plus the test). Parent: TRDD-WSPV40Y5.

## Approval log

- 2026-11-18T15:51:31+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
