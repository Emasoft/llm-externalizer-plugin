---
trdd-id: 7H5MGN34
title: Remote ensemble may never fan out because non-reserved members carry no route
column: todo
status: tasked
created: 2026-10-28T21:08:06+0100
updated: 2026-10-28T21:08:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-28T21:08:06+0100
---

# Remote ensemble may never fan out because non-reserved members carry no route

Suspected bug found while researching the local ensemble (report reports/llama-cpp-profile/20261028_200508+0100-ensemble-scout-routes-facts.md, section 1, lines 18-19). Read from the code, not yet confirmed by a run.

ensembleStreaming in scripts/llm-ext/src/index.ts (about line 3434) takes the multi-model path only when every member has a route. getEnsembleModels (about lines 3986-4126) attaches a route only to reserved members (about 4012); model, second_model, third_model and free-pool members come back without one (about 4119). Read literally, any ensemble with a non-reserved member falls back to the single-model path, so a plain remote-ensemble profile would never fan out. No test drives a fan-out through ensembleStreaming.

First step: reproduce with a real run on a remote-ensemble profile and count the models that answered. If confirmed: give every member a route (or relax the guard), and add a test that drives a 3-member fan-out through a tool. Related: TRDD-1OOAH3LD and TRDD-ZGSGGHQG, whose local ensemble depends on the same path.

## Approval log

- 2026-10-28T21:08:06+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
