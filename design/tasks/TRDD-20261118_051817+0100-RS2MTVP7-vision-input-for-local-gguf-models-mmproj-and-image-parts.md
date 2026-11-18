---
trdd-id: RS2MTVP7
title: Vision input for local GGUF models (mmproj and image parts)
column: backburner
status: tasked
created: 2026-11-18T05:18:17+0100
updated: 2026-11-18T05:44:50+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:17+0100
---

# Vision input for local GGUF models (mmproj and image parts)

Add --mmproj in buildServerArgv (local-llama-server.ts:110-136), count the mmproj file in readiness, estimate and fingerprint, and send image_url parts in the local completion body. TRDD-7CFPEDUK is its first consumer. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-18T05:44:49+0100 From TRDD-GNKO7WZS (8e093733): llama-server -hf downloads the mmproj sidecar of a vision repo by default (arg.cpp:384-401 at llama.cpp 8642541b2: download_mmproj unless --no-mmproj or --mmproj is given), and local-llama-server.ts passes no mmproj flag. So readiness, which ignores the projector, can call a vision repo with an uncached projector ready while the server then downloads it. No current fallback head is a vision repo, so no run is affected today. This card owns it: count the projector in readiness, or pass --no-mmproj while no image parts are sent.
