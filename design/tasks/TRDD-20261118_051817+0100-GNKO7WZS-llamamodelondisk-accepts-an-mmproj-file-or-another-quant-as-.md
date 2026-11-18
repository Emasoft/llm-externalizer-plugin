---
trdd-id: GNKO7WZS
title: llamaModelOnDisk accepts an mmproj file or another quant as the model weights
column: todo
status: tasked
created: 2026-11-18T05:18:17+0100
updated: 2026-11-18T05:18:17+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:17+0100
---

# llamaModelOnDisk accepts an mmproj file or another quant as the model weights

llamaModelOnDisk (network-give-up.ts:117-128) treats a repo:quant model as on disk when any .gguf file name in the snapshot contains the quant text, so an mmproj file (mmproj-...-Q8_0.gguf, mmproj-...-F16.gguf) or another quant (Q4_K matches Q4_K_M and Q4_K_S) can make an absent model look ready. Fix: match the LLM weight file (not mmproj) and the quant as a whole token; test both cases. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
