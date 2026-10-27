---
trdd-id: J7AIC7ZW
title: Local last-resort tier with Nanbeige4.2-3B through Krill
column: backburner
status: tasked
created: 2026-10-27T23:56:09+0100
updated: 2026-10-27T23:56:09+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T23:56:09+0100
---

# Local last-resort tier with Nanbeige4.2-3B through Krill

Parent: TRDD-UT7UC025. Last tier, after the remote tiers fail.

## Measured facts (2026-10-27)
- Krill (github.com/srvsngh99/Krill, MIT, Swift+MLX) runs only on macOS Apple Silicon; serves OpenAI-compatible /v1/chat/completions on 127.0.0.1:57455; alias nanbeige-4.2-3b -> srv-sngh/Nanbeige4.2-3B-mlx-nvfp4 (2.37 GB, public repo, no token needed technically).
- Krill routes /ui and /v1/agent/* with no guard and no flag to turn them off (Server.swift:526-533): any local process can run bash through it while it is up.
- Krill has no LFM alias; LFM3-1.7B needs another runner (mlx-lm on Apple Silicon).
- Nanbeige opens every reply with a think block: thinking off per request, max_tokens >= 4000. Krill silently drops a JSON grammar that fails to compile: llm-ext validates the JSON itself and retries once.
- Highest tool context floor is 128k (tool-context-floors.ts), under Nanbeige's 256k.

## Scope
- Gate: HUGGINGFACE_API_TOKEN or HF_TOKEN set (USER-stated consent signal; keep the gate even though the repo is public). Download only on demand, after the remote tiers fail; never because of a key error.
- Install a pinned Krill release with its sha256 into a user-owned prefix (no sudo); check free disk space first; a time limit on first download and start.
- Lifetime: because /ui cannot be turned off, the server stops after each command (USER can veto in favour of staying up).
- Every result carries a visible "local fallback, degraded" label (USER can veto).
- Linux and Intel: no runner yet; record as a gap rather than claim coverage.

## Acceptance
- [ ] without a token, no install and no download happen
- [ ] with remote tiers forced to fail, a command returns a labelled local answer and the server is stopped afterwards

## Approval log

- 2026-10-27T23:56:09+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
