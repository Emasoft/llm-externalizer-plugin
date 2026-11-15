---
trdd-id: VDH3MDKT
title: Harden the free-forbidden-tools derivation against silent misses
column: complete
status: archived
created: 2026-10-07T12:40:51+0200
updated: 2026-10-31T21:04:21+0100
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
- 2026-10-31T21:04:21+0100 — COMPLETE by main-agent@llm-externalizer-plugin. 8e9533d6 + cc3594d5; every free-served reason verified against the code, the one wrong reason corrected in d66aecfe; ships in 14.3.0.

## Scope

Follow-up from the adversarial review of ab52831a (TRDD-KV2WCFCS).
1. Assert the number of dispatch cases the test derives equals the catalog tool count (buildTools names minus a reasoned exclusion list), so a parse miss from formatting, nesting or a fall-through case turns the test red; or reuse the AST call graph of Sections 1-2 instead of indentation matching.
2. List assess_model, check_model_health and discover_new_models explicitly in the test as known senders whose sender is injected, each with its free-mode decision.
3. Make the sender markers a named list (chat/completions now; /alpha/decisions when the classifier transport of TRDD-ZB41KG62 exists).
4. Re-check that each FREE_SERVED_LLM_TOOLS reason is accurate per tool, especially session_summary and cluster_synonyms.

## Acceptance

- [x] the test asserts the derived dispatch-case count equals the catalog tool count (buildTools names minus a reasoned exclusion list) - evidence: free-forbidden-tools.test.ts ~752 (8e9533d6, cc3594d5)
- [x] assess_model, check_model_health and discover_new_models are listed as known senders with their free-mode decision - evidence: free-forbidden-tools.test.ts:691-694 CATALOG_ONLY_TOOLS
- [x] the sender markers are a named list - evidence: free-forbidden-tools.test.ts:424 SENDER_MARKERS incl. alpha/decisions, with its occurs-in-src test
- [x] each FREE_SERVED_LLM_TOOLS reason is re-checked as accurate per tool (session_summary, cluster_synonyms) - MISSING: not verifiable from code, no check recorded
- 2026-10-31 proof pass 1, box 4 left OPEN: 17 of 18 FREE_SERVED_LLM_TOOLS reasons hold against the code (core tools reach ensembleStreaming or processFileCheck, index.ts dispatch; check_imports uses chatCompletionJSONWithFreeRotation; cluster_synonyms rotates the free pool in free mode, else chatCompletionWithProfileFallback, 4096 cap and reasoning off, index.ts case cluster_synonyms; the three benchmark/probe tools pick their own candidates, mass_scouting/mcp-tools.ts cases). WRONG: session_summary says one completion per chunk, but session_summary/driver.ts races several models on a single-chunk run (raceSingleChunk, driver.ts:1740-1777) and hedges a slow chunk with a second model (raceForFirstOk, driver.ts:2409); the models still come from selectModels (free only), so free-served holds but the reason text must change. A one-line edit of the reason string in free-forbidden-tools.test.ts is a separate decision.
Done: 17 of 18 reasons verified (07ba007a); session_summary reworded to its real behaviour (raceSingleChunk, raceForFirstOk; models from selectModels, free only) in d66aecfe.
