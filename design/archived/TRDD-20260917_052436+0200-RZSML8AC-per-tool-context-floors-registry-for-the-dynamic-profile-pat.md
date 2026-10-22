---
trdd-id: RZSML8AC
title: Per-tool context floors registry for the dynamic-profile patch
column: complete
created: 2026-09-17T05:24:36+0200
updated: 2026-10-05T20:25:07+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-17T05:24:36+0200
parent-trdd: 90DM5YHO
review-after: 
blocker-probe: 
blocker-holds-if: 
npt: []
blocked-by: []
unblock-when: []
pre-block-column: 
status: archived
implementation-commits: 38be2c30
---

# Per-tool context floors registry for the dynamic-profile patch

WHY: toolContextFloors is caller-injected because no tool-requirements registry exists in this codebase; three passes confirmed no cheap way to derive it (fix-queue item 28, P4 + P6b reports). WHAT: build a per-tool context-floors registry so the dynamic-profile $0 patch can consult it directly instead of relying on the caller to inject a value, and drop a head only when it does not fall below the tool's registered floor. ACCEPTANCE: a dynamic-profile selection test shows the patch refusing to drop a head below the registered floor for at least one tool, with no caller-supplied toolContextFloors argument. Deferred from TRDD-90DM5YHO release 14.0.0 on 2026-09-17; fix-queue item 28.

## Approval log

- 2026-09-17T05:24:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-17T05:35:46+0200 — column → blocked. deferred until release 14.0.0 (TRDD-90DM5YHO) reaches a terminal column
- 2026-10-04T11:00:00+0200 — deliberate override recorded by main-agent@llm-externalizer-plugin: blocker 90DM5YHO reached complete (archived); the post-14 deferral is lifted per USER mandate (finish every open card); blocker fields cleared by hand.
- 2026-10-04T12:40:24+0200 — column → todo by main-agent@llm-externalizer-plugin. 90DM5YHO complete; USER mandate lifts the post-14 deferral
- 2026-10-05T20:25:07+0200 — COMPLETE by main-agent@llm-externalizer-plugin. Registry landed, dead field deleted, 3 acceptance tests RED->GREEN, gates 0, coordinator re-run 109/109, review SHIP verdict with 3 disclosures recorded. Commit 38be2c30..

## Acceptance

- [x] AC-1 registry consulted directly (no caller injection): TOOL_CONTEXT_FLOORS read at default-profiles.ts:577; input field toolContextFloors DELETED; pre-fix the 3 new tests failed (expected 'a/big-ctx', got undefined), post-fix 47/47 default-profiles + 62/62 dynamic-maintainer green. [x] --approver main-agent@llm-externalizer-plugin
- [x] AC-2 registry values pinned to design-time sources: every entry cites model-qualification/registry.ts requirements.minContextTokens (DEFAULT_CRITERIA 128_000 benchmark/discover.ts; SECURITY_TRIAGE_CRITERIA 16_000 benchmark/security-triage/select.ts) derived from the FREE_POOL_SEED 'context >= 128K' criteria (config.ts:3664, curated 2026-05-27); no invented numbers. [x] --approver main-agent@llm-externalizer-plugin
- [x] AC-3 acceptance test shows polarity (below-floor DROPPED + refilled at-or-above; at-floor KEPT; no qualifying fallback -> removed) with NO caller-supplied toolContextFloors argument possible: 3 tests in default-profiles.test.ts TRDD-RZSML8AC describe. [x] --approver main-agent@llm-externalizer-plugin
- [x] AC-4 gates: typecheck 0, lint 0 (--max-warnings 0), build 0; touched test files green on three env legs (as-is TMPDIR/private/tmp, isolated LLM_EXT_CONFIG_DIR + no API keys, second /private/tmp leg); dynamic-maintainer.test.ts S-2 fixture updated (context_length 128_000) per the new registry floor. [x] --approver main-agent@llm-externalizer-plugin
(superseded — see the 201205 report path below)
Impl report: reports/llm-ext-release/20261005_201205+0200-rzsml8ac-impl.md (worker). Implementation commits: coordinator. Column left at todo per brief (coordinator moves). --approver main-agent@llm-externalizer-plugin
2026-10-05 review disclosures (coordinator, ship verdict): (1) fail-closed-on-unknown-context is now ACTIVE behavior on dynamic profiles — a tool_models head whose catalog entry lacks context_length is treated as 0 and dropped (pre-existing ?? 0 semantics, unexercised until the registry gave the floor teeth); CHANGELOG/release-notes line owed. (2) below-floor head drops are silent — follow-up: one-line stderr note at the drop site. (3) 109/109 evidence covers the two touched files; the E1 full-suite three-leg run (WBZJRSQB step 11) remains the backstop.
