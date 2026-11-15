---
trdd-id: PEZ08FM4
title: Guidelines for projects that call the llm-ext CLI (profiles, maintenance, concurrency, reports, settings, upgrades, exit codes, local servers, cost)
column: dev
status: tasked
created: 2026-11-14T21:28:24+0100
updated: 2026-11-14T21:41:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T21:28:24+0100
---

# Guidelines for projects that call the llm-ext CLI (profiles, maintenance, concurrency, reports, settings, upgrades, exit codes, local servers, cost)

Requested 2026-11-14 by the perch session on the owner's request (cross-session message): one document a consuming project (its Claude session, scripts, hooks, CI) can follow, answering 9 questions: 1 profiles to pass and the missing active: key; 2 background maintenance (availability re-check, benchmark) duration, whether in-flight work waits, caller timeouts, --command_timeout/--queue_timeout; 3 concurrency of several commands and overlapping benchmarks; 4 the reports root (gitignore, commit, or redirect with -o / LLM_EXT_OUTPUT_DIR); 5 which commands write settings.yaml, what not to hand-edit, how a custom profile survives the benchmark rewrite; 6 upgrades, version pinning, stable scripting surface; 7 exit codes 0 / non-zero with paths / 124 / 402 and what is retryable; 8 llm-ext servers (llama-server 8181, Locals 9090) vs a project's own server (mlx-decision 8123), avoiding a model loaded twice; 9 --estimate and files never to pass. Home: skills/llm-externalizer-cli-reference/references/consumer-guidelines.md, linked from that skill's SKILL.md. Every answer verified against code at HEAD; answers that depend on in-flight work (TRDD-3SNQAGIC, TRDD-TYHKAKCB, the release) say so.

## Approval log

- 2026-11-14T21:28:24+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-11-14T21:37:18+0100 The profile and settings answers (questions 1 and 5) depend on the profile contract redesign ordered by the USER on 2026-11-14 (TRDD-SZ7TO9FW): the guidelines must define the stable user/tool surface vs the internal benchmark-managed settings, a pinning/customizing procedure that survives benchmark updates, and the implicit local fallback. Those sections are written after SZ7TO9FW is designed.
2026-11-14T21:41:31+0100 consumer-guidelines.md written (99 lines, worker report reports_dev/sonnet-worker/20261114_214106+0100-pez08fm4-consumer-guidelines.md); questions 2-4 and 6-9 complete, 1 and 5 wait on TRDD-SZ7TO9FW. Follow-up found: skills/llm-externalizer-cli-reference/SKILL.md cost rules still say a 402 switches to free models, stale since llm-ext stopped switching; fix it with the SZ7TO9FW docs pass.
