---
trdd-id: 8CCKM4XE
title: Empty free_models error says how to fill the free pool
column: published
status: archived
created: 2026-11-16T09:31:09+0100
updated: 2026-11-16T15:14:16+0100
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
implementation-commits: [7b0a76d8]
---

# Empty free_models error says how to fill the free pool

## Problem

GitHub issue 16 item 4. validateProfile (scripts/llm-ext/src/config.ts about line 2814) refuses a free_only profile whose free_models list is empty with the bare line "free_only requires a non-empty free_models list." A fresh settings.yaml ships free_models: [] as a placeholder, so a user hits this with no hint how to fill the pool.

## Fix

Append to that message how to fill it: run llm-ext-benchmark --update-all --profile <name> (zero cost, writes the free_models pool) or list :free model ids under free_models. Keep the existing wording as the prefix so free-only.test.ts and callers that match it still match.

## Acceptance

- [x] the error names the profile, keeps the old prefix and names the update-all command and the manual alternative
- [x] a test asserts the hint text

## Approval log

- 2026-11-16T09:31:09+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T09:41:33+0100 — column → testing by main-agent@llm-externalizer-plugin. fix landed 7b0a76d8; dist rebuild and full suite owed at release
- 2026-11-16T15:14:16+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. fix 7b0a76d8 shipped in v14.3.1; both acceptance boxes ticked.
