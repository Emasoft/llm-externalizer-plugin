---
trdd-id: 0ICSRZ0K
title: getModelSupportedParams re-fetches endpoints on every call when the result is null
column: backburner
status: tasked
created: 2026-10-10T11:21:18+0200
updated: 2026-10-10T11:21:18+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T11:21:18+0200
---

# getModelSupportedParams re-fetches endpoints on every call when the result is null

## Goal

getModelSupportedParams (scripts/llm-ext/src/provider/completion.ts ~242-292) never caches a null result: a non-ok reply, an empty endpoints array or an empty supported-parameters Set. So a b.ai-routed model under an OpenRouter primary (likely a 404, inferred) and every model whose supported_parameters list is empty pay one /endpoints GET on every call, an extra round trip on the fast paths (owner directive: 'jev must be ultrafast'). Cache the null result for the same lifetime as a hit, keeping the existing callers' return value unchanged.

## Evidence

Fable advisor report docs_dev/20261010-yg72-inc4-advisor.md, 'Out of scope' (read, not run). The 404 for a routed model id is inferred.

## Acceptance

- [ ] a test with a real local server answering /endpoints 404 shows one GET across two calls (failing before)
- [ ] a test with an empty supported_parameters list shows one GET across two calls (failing before)
- [ ] existing callers receive the same value as today; existing tests unchanged
- [ ] definition of done: typecheck, lint and eslint . --quiet clean, full npm test green, one commit with the TRDD id in its subject

## Related

TRDD-YG72CYY7 (decision E10; increment 4 must not change this function's return value).

## Approval log

- 2026-10-10T11:21:18+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
