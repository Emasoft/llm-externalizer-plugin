---
trdd-id: KV2WCFCS
title: Strengthen forbidden-tools completeness test against unmarked LLM-driving tools
column: complete
created: 2026-09-17T05:24:37+0200
updated: 2026-10-07T12:40:51+0200
current-owner: agent
created-by: user
task-type: bugfix
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-17T05:24:37+0200
parent-trdd: 90DM5YHO
review-after: 
blocker-probe: 
blocker-holds-if: 
npt: []
blocked-by: []
unblock-when: []
pre-block-column: 
status: archived
implementation-commits: [ab52831a]
---

# Strengthen forbidden-tools completeness test against unmarked LLM-driving tools

WHY: free-forbidden-tools.test.ts reddens only for a handler that is MARKED but not listed; an unmarked new LLM-driving tool stays green, so completeness is not guaranteed by derivation from resolveCliModel / chat/completions call sites alone (fix2-review N-4, fix-queue item 47, still conditional on whether P6c-a2 absorbed it). WHAT: strengthen the forbidden-tools completeness test by scanning resolveCliModel and chat/completions call sites directly, so an unmarked new LLM-driving tool also reddens the test. ACCEPTANCE: adding a new unmarked LLM-driving tool call site (no forbidden-tools registration) causes free-forbidden-tools.test.ts to fail, not stay green. Deferred from TRDD-90DM5YHO release 14.0.0 on 2026-09-17; fix-queue item 47.

## Approval log

- 2026-09-17T05:24:37+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-17T05:35:51+0200 — column → blocked. deferred until release 14.0.0 (TRDD-90DM5YHO) reaches a terminal column
- 2026-10-04T11:00:00+0200 — deliberate override recorded by main-agent@llm-externalizer-plugin: blocker 90DM5YHO reached complete (archived); the post-14 deferral is lifted per USER mandate (finish every open card); blocker fields cleared by hand.
- 2026-10-04T12:40:31+0200 — column → todo by main-agent@llm-externalizer-plugin. 90DM5YHO complete; USER mandate lifts the post-14 deferral
- 2026-10-07T12:40:51+0200 — COMPLETE by main-agent@llm-externalizer-plugin. landed ab52831a; acceptance verified, ceilings recorded.

## Acceptance

- [x] Card acceptance (verbatim): adding a new unmarked LLM-driving tool call site (no forbidden-tools registration) causes free-forbidden-tools.test.ts to fail, not stay green. Evidence: a scratch case calling ensembleStreaming made the test fail (1 failed, 11 passed) naming the tool and both lists; removed, index.ts byte-identical.
- [x] Recorded ceilings (follow-up card filed): cases are found by indentation, not syntax; a sender is recognised only when name resolution reaches the literal chat/completions; assess_model, check_model_health and discover_new_models get their sender injected and are not derived.
