---
trdd-id: VQKH92OI
title: Real-build publish test never exercises the missing node_modules branch
column: todo
status: tasked
created: 2026-11-20T00:27:26+0100
updated: 2026-11-20T00:27:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T00:27:26+0100
---

# Real-build publish test never exercises the missing node_modules branch

tests/test_publish_real_build_stale_dist.py covers a stale dist with node_modules present; the run_build_check branch for absent node_modules (15e53512) has never run in any test.

## Approval log

- 2026-11-20T00:27:26+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] a test runs run_build_check with no node_modules and asserts the named outcome, or the card records why that branch cannot be reached.
