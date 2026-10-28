---
trdd-id: ZGSGGHQG
title: llm-ext runs local MLX models through the Locals server with a mac-only locals-mlx profile
column: todo
status: tasked
created: 2026-10-28T19:10:21+0100
updated: 2026-10-28T19:11:31+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-28T19:10:21+0100
---

# llm-ext runs local MLX models through the Locals server with a mac-only locals-mlx profile

## Approval log

- 2026-10-28T19:10:21+0100 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## User directive (verbatim, 2026-10-28)

> now i need you to add this mac-only profile called 'locals-mlx'. this profile must only execute local models in mlx format, and it must use the locals server:
> `https://github.com/Generated-Computers/Locals`. I already installed the latest version (with `uv tool install https://github.com/Generated-Computers/Locals.git --python 3.12`). The command to start the server is this: `locals serve --model LiquidAI/LFM3-1.7B-MLX-4bit --port 9090`

## Related

TRDD-1OOAH3LD (local_llama via llama.cpp; its server-supervisor plan design/specs/TRDD-1OOAH3LD-increment-2a-plan.md may share a seam with this profile) and TRDD-UT7UC025 (calibration of new models applies to every profile).
