---
trdd-id: N0S2UL0K
title: models health and other model tools fail on a managed local profile in default free mode
column: todo
status: tasked
created: 2026-10-29T05:51:23+0100
updated: 2026-10-29T16:15:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-29T05:51:23+0100
---

# models health and other model tools fail on a managed local profile in default free mode

Symptom: with a fresh temp HOME and LLM_EXT_CONFIG_DIR, and settings.yaml whose active profile is a managed local profile (profile-type local, api llamacpp-local, server managed), running 'llm-ext models health' exits 1 with: 'Error: free mode is active but the active profile defines no free models (free_models: [] and no free-provider providers: binding). Add free_models, or a providers: entry for a free provider (e.g. chat-b-ai-remote), or set allow_paid_models: true.' Adding allow_paid_models: true did not change it. Cause (read in src/index.ts): the MASS_SCOUT_TOOL_NAMES branch of the tool dispatch calls resolveMassScoutFreeModelOverride() for every tool except the scouting-only ones; it calls activeFreePool(), which throws when the pool is empty. For a tool whose model argument names a LOCAL model, the injection would also replace that model with a remote free id. P6 step 2 (TRDD-1OOAH3LD) excluded only calibrate_model and calibration_status. Found 2026-10-29 while testing 'llm-ext models calibrate'. Fix to decide: which model tools need a free-pool model at all, and why free mode counts as active on a local profile.

## Approval log

- 2026-10-29T05:51:23+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Fix

resolveMassScoutFreeModelOverride (src/index.ts) now returns undefined when free mode is off and builds the free pool only when it is on: free mode was never active on a local profile, but activeFreePool() was evaluated eagerly as an argument and threw; also stops the same false throw on a funded remote profile (allow_paid_models true); tests in src/auto-free.test.ts (TRDD-N0S2UL0K describe)
