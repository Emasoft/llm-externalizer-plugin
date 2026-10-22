---
trdd-id: RLINOTZR
title: OpenRouter generation cost trail and public benchmark prefilter
column: backburner
created: 2026-09-23T11:19:27+0200
updated: 2026-09-23T11:19:58+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-23T11:19:27+0200
---

# OpenRouter generation cost trail and public benchmark prefilter

## Approval log

- 2026-09-23T11:19:27+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Scope

Source: report 20260923_111500+0200-openrouter-skills-evaluation.md (OpenRouter skills evaluated 2026-09-23).
PROPOSED, NOT ADOPTED - needs a USER yes; verify the :free path first: GET /api/v1/models/{author}/{slug}/endpoints (live on a PAID id only: status, uptime_last_5m/30m/1d, latency_last_30m, throughput_last_30m per upstream host). Possible uses: exclude a model whose hosts are all down (a THIRD eligibility criterion the USER never set - the rule is benchmark + price; uptime windows are noisy and a :free variant often has one host); rank remote models by throughput (USER 3.2 names tok/s for LOCAL only). Before any adoption: verify the :free path, measure calls per refresh and free-key rate limits. It does NOT fix TRDD-W9XLU1HD (403-rejecting models - already fixed by da917e9/527d5e8/c8b2700) and is NOT a D6 provider-group signal.
LATER (after 14.1.0): GET /api/v1/generation?id= (exact per-request cost and provider fallback trail - debugging and a cost-accounting cross-check); GET /api/v1/benchmarks (public coding and intelligence indices to pre-filter paid benchmark candidates before spending on them; needs a permaslug to id mapping).
Rejected in the same evaluation (not useful, no card needed): the three analytics endpoints (need a management key, USER ruled no), the TypeScript SDK, open-responses, agent-migration (llm-ext speaks /v1/chat/completions directly with its own fetch client), oauth (stores the key, conflicts with key-from-env), agent scaffolders, the Ori harness, and images/stt/tts/video.
