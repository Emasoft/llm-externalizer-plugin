---
trdd-id: R7NKAJ5B
title: Local model catalog with role, runtime, inputs and abliterated metadata
column: todo
status: tasked
created: 2026-11-18T05:18:16+0100
updated: 2026-11-18T05:18:16+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:16+0100
---

# Local model catalog with role, runtime, inputs and abliterated metadata

Add a catalog with one entry per local model: exact id, repo, runtime (llama.cpp, mlx, mlx-decision), role (chat, decider, speech), inputs, mmproj file, abliterated flag, sizes from the HF API, verified-here flag with how, and the reason where llm-ext cannot run it. Entries cover the six current built-in models and the eight repos of the parent. Add a test that the built-in profiles use only catalog chat entries of the right runtime, and check the docs table in skills/llm-externalizer-cli-reference/references/models-and-settings.md against the catalog. No fallback behaviour changes. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
