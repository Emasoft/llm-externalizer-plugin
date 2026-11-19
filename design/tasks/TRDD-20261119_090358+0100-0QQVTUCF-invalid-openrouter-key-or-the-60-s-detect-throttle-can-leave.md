---
trdd-id: 0QQVTUCF
title: Invalid OpenRouter key or the 60 s detect throttle can leave a real paid-profile run that starts no benchmark
column: backburner
status: tasked
created: 2026-11-19T09:03:58+0100
updated: 2026-11-19T09:03:58+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T09:03:58+0100
---

# Invalid OpenRouter key or the 60 s detect throttle can leave a real paid-profile run that starts no benchmark

Residual of TRDD-P10QMUW7 (commit 16426995, shipped in v14.7.5). Per the static trace in reports_dev/p10-trace/20261119_053811+0100-paid-nokey-trace.md (not run), with the never-benchmarked generated paid profile, a key that is present but invalid, or a second real run inside the 60 s per-profile detect throttle, can still leave a real run that starts no paid benchmark; what that run prints in those cases was not checked. Also not shown: that a real run with a valid key starts the sweep; that needs a real paid key, which only the USER can authorize. Verify the first two cases on the built CLI with a temp HOME and LLM_EXT_CONFIG_DIR, LLM_EXT_INSTALL_RULE=0 and a deliberately invalid key (never a valid paid key), then make the printed message true for both cases, with a test. Size S.

## Approval log

- 2026-11-19T09:03:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
