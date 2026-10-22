---
trdd-id: VXZQUBNS
title: L2-03 Planner limits from catalog and profile
column: complete
status: archived
created: 2026-10-07T19:21:40+0200
updated: 2026-10-10T00:50:09+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:21:40+0200
implementation-commits: [539e0804, e8d7d255, 0421472e]
---

# L2-03 Planner limits from catalog and profile

## Goal
Compute `ModelLimits` from the resolved catalog model, with the profile `context_tokens` as the only override.

## Approval log

- 2026-10-07T19:21:40+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:49:55+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:50:01+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:50:09+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§5 (Limits), §4 (model limits owned by the decisions catalog; profile `context_tokens` only an override), §3 (`ModelLimits`); E18.

## Depends on

L2-01 (TRDD-YB1KEVKC), L0-08 (TRDD-MKEWC00E)

## Files

- `scripts/llm-ext/src/classifiers/l2/planner.ts`
- `scripts/llm-ext/src/classifiers/l2/planner.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`resolveModel` (L0-08). Read the code at card start.

## Steps

1. `contextTokens = min(context_length, endpoint max_prompt_tokens)` from the resolved catalog model (§5).
2. When the catalog reports 0 or null, the profile `context_tokens` is required, else refuse (E18).
3. If probe P-01 shows a second limit, add it to `ModelLimits` and change nothing else (§5). (derived from done-when)

## Acceptance

- [x] limits read from the catalog
- [x] profile `context_tokens` only as override
- [x] E18: Catalog `context_length: 0` → profile `context_tokens` required, else refuse
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 539e0804 (one commit for L2-01, L2-02 and L2-03), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/planner.ts modelLimits, ENVELOPE_TOKENS, types LimitsProfile, LimitsInput, LimitsRefusal; l2/planner.test.ts (describe L2-03 modelLimits and review rounds). Limits read from the catalog; E18 refuses with kind no-context-limit when the catalog reports 0/null and the profile has no context_tokens. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. Deviation: the catalog 64000 context is wrong for the endpoint, so callers pass endpointPromptLimit and the planner takes the min. OPEN ITEMS: profile context_tokens applies only when the catalog reports none (plan section 4 wording); a known endpoint limit caps the context.

## Out of scope

Catalog loading (L0-07), alias resolution (L0-08).
