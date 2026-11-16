---
trdd-id: 8CCKM4XE
title: Empty free_models error says how to fill the free pool
column: dev
status: tasked
created: 2026-11-16T09:31:09+0100
updated: 2026-11-16T09:31:09+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T09:31:09+0100
---

# Empty free_models error says how to fill the free pool

## Problem

GitHub issue 16 item 4. validateProfile (scripts/llm-ext/src/config.ts about line 2814) refuses a free_only profile whose free_models list is empty with the bare line "free_only requires a non-empty free_models list." A fresh settings.yaml ships free_models: [] as a placeholder, so a user hits this with no hint how to fill the pool.

## Fix

Append to that message how to fill it: run llm-ext-benchmark --update-all --profile <name> (zero cost, writes the free_models pool) or list :free model ids under free_models. Keep the existing wording as the prefix so free-only.test.ts and callers that match it still match.

## Acceptance

- [ ] the error names the profile, keeps the old prefix and names the update-all command and the manual alternative
- [ ] a test asserts the hint text

## Approval log

- 2026-11-16T09:31:09+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
