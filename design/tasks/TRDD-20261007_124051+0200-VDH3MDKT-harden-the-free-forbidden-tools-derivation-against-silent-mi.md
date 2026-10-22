---
trdd-id: VDH3MDKT
title: Harden the free-forbidden-tools derivation against silent misses
column: backburner
status: tasked
created: 2026-10-07T12:40:51+0200
updated: 2026-10-07T12:41:08+0200
current-owner: user
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T12:40:51+0200
---

# Harden the free-forbidden-tools derivation against silent misses

## Approval log

- 2026-10-07T12:40:51+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Scope

Follow-up from the adversarial review of ab52831a (TRDD-KV2WCFCS).
1. Assert the number of dispatch cases the test derives equals the catalog tool count (buildTools names minus a reasoned exclusion list), so a parse miss from formatting, nesting or a fall-through case turns the test red; or reuse the AST call graph of Sections 1-2 instead of indentation matching.
2. List assess_model, check_model_health and discover_new_models explicitly in the test as known senders whose sender is injected, each with its free-mode decision.
3. Make the sender markers a named list (chat/completions now; /alpha/decisions when the classifier transport of TRDD-ZB41KG62 exists).
4. Re-check that each FREE_SERVED_LLM_TOOLS reason is accurate per tool, especially session_summary and cluster_synonyms.
