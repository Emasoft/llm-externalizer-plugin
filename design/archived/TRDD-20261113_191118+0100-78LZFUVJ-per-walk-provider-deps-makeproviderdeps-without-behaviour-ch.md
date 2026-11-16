---
trdd-id: 78LZFUVJ
title: Per-walk provider deps (makeProviderDeps) without behaviour change
column: published
status: archived
created: 2026-11-13T19:11:18+0100
updated: 2026-11-16T20:15:26+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T19:11:18+0100
derived: true
parent-trdd: UT7UC025
implementation-commits: [ca2c097f]
---

# Per-walk provider deps (makeProviderDeps) without behaviour change

## Origin

Increment 1c of TRDD-WSPV40Y5 (automatic fallback of general commands to a ready local profile). Split out of WSPV40Y5 in revision 3 after the final review; the text under the Moved heading is moved verbatim from WSPV40Y5 revision 2. In moved text, section numbers and Qn refer to WSPV40Y5, and 1a 1b 1c 1d are the four increments (1d = WSPV40Y5 itself, the fallback helper; it consumes 1a, 1b and 1c, so they land first). Markers: [V] = VERIFIED, file:line read in the card session; [I] = INFERRED, the implementer must read it before relying on it. All paths under scripts/llm-ext/src/. Parent: TRDD-UT7UC025. One commit.

## Scope (1c)

A pure seam refactor, NO behaviour change: nothing calls the new functions with another profile until 1d.
 1. Refactor providerDeps into makeProviderDeps(profile, backend), one source for the 12 fields; the boot object becomes makeProviderDeps over activeResolved and currentBackend. The 12 fields are the SWITCH list of item 2 below (getBackend, apiHeaders, routeForModel, routeHeaders, getSoftTimeoutMs, isFreeOnly, isLMStudioProvider, isManualModel, getRequestOptions, getActiveProtocol, localBroker, getDefaultMaxTokens), plus the markProfileUsed name of item 9.
 2. Refactor localSizingForCommand (index.ts:218-246) into localSizingFor(profile, tool) (one source for the member construction); the command-level function becomes a call with the active profile.
 3. The module globals (activeResolved, currentBackend, the free-state publication, the spend guard) are NOT touched: they keep describing the REMOTE profile (items 1, 3, 5, 7, 8 below).
 Proof = the full existing suite passes unchanged. The use of these functions over the target profile (and a backend built ONCE with makeBackendFromProfile) is 1d.

## Moved from WSPV40Y5 section 5: the activeResolved inventory and the decision (per-walk deps)

 - BINDING problem [V] and DECISION. Inventory of the readers of the module global activeResolved, by grep -nw over non-test .ts files (131 lines: 126 in index.ts, the rest comments in profile-detector.ts:195, config.ts:4698, cli/main.ts:908 and 936, provider/types.ts:12); getCurrentBackend has 17 call sites (tldr references, full list) and currentBackend 3 references (declared 776, read 791, written 1049) [V]. Grouped by function, each with KEEP (describes the remote profile, untouched) or SWITCH (reads the target through per-walk deps):
   1. KEEP, the writers: the boot IIFE index.ts:588, the atomic swap at 1008 with setActiveRouting, setAllowPaidModels and publishFreeState, SOFT_TIMEOUT_MS 718, FALLBACK_CONTEXT_LENGTH 719, currentBackend 776 and 1049, overrideActiveProfile 1084. The fallback never writes any of them.
   2. SWITCH, the provider seam providerDeps (index.ts:~1930-1985): getBackend (1932), apiHeaders (1790), routeForModel (1937), routeHeaders (1896-1906), getSoftTimeoutMs (target timeout x 1000), isFreeOnly (1940), isLMStudioProvider (1941), isManualModel (1945), getRequestOptions (1958), getActiveProtocol (1959), localBroker (1967) and getDefaultMaxTokens (resolveDefaultMaxTokens 174-193: reads localSizingForCommand, which is null for a remote profile, then the REMOTE backend model cache or FALLBACK_CONTEXT_LENGTH = 100000, and would hand a local model that cap; the target sizing maxTokens replaces it). On a remote profile localBroker returns null (r.server null), so a primary local route would fall through to the primary-backend path, which builds its URL from backend.baseUrl, the REMOTE endpoint (connection.ts:~253-262, lmstudio branch read, the openai branch [I]). The completion layer reads profile state ONLY through deps (its other imports are pure config helpers, usage-history, governor and broker client [V import list]), so a per-walk deps object is a COMPLETE switch.
   3. COST AND SPEND, KEEP the published state, SWITCH the per-call reads: modelIsBillable (connection.ts:31-37) and billableForRoute (completion.ts:1873) key on the route and backend they are given. With the remote deps a local call would get routeForModel null (completion.ts:1839), so billableForSpendStop would be the PAID profile billable flag and local empty replies would count against RUN_PAID_EMPTY_RETRY_BUDGET (30, completion.ts:1340, 1867-1884) and use the remote empty-retry budget of 15 (completion.ts:1850-1858) [V]. Per-walk deps make the local route non-billable. The published spend state (setActiveFreeOnly, setActiveRouting and getActiveBillableForModel config.ts:4752-4766, readers index.ts:4400, mass_scouting, security_scan/judge) stays on the remote profile, so the paid guard keeps seeing it: untouched.
   4. COST RECORDING: recordUsage (index.ts:1756-1773) adds usage.cost only when it is a number and completion.ts:742 records usage?.cost ?? 0; a llama.cpp or Locals reply carries no cost, so a local answer adds nothing and is recorded as 0 in the usage history, exactly like a --profile local run [V]. usage-totals.ts:27-31 prints cost unknown when a file reports none, on purpose for local or unpriced servers. DECISION: do NOT stamp a 0 cost (consistent with existing local runs); the paid guard keys on billability, not on this number.
   5. KEEP, concurrency: getRateLimitConfig (index.ts:1266-1345, DEFAULT_MAX_IN_FLIGHT_REMOTE = 200 at 696) sizes the per-file pool at command start for the remote profile, before any failure. After a latch the pool still submits up to that many files and the broker queue and one-model-at-a-time rule absorb them. Accepted, see section 7.
   6. KEEP then SEPARATE, sizing: localSizingForCommand (index.ts:218-246) returns null for a remote profile, so dispatch injects NO calibrated per-file budget (index.ts:4913-4960 [V]) and per-file input stays max_payload_kb ?? 400 KB. The fallback sizes itself: refactor localSizingForCommand into localSizingFor(profile, tool) (one source for the member construction) and call it with the TARGET.
   7. KEEP, fan-out and selection decided from the remote profile before any failure: getEnsembleModels and canFanOut (3655, 3675, 4320-4450), the ensembleAllowed call sites (5018, 5320, 5349, 6489, 6870-6977, 7385, 7970), free mode and pool (2990-3026, 3073-3260), model selection (2913, 3836, 4036-4084). Increments 2 and 3 revisit them.
   8. KEEP, info and status tools (5451-5543, 5800, 5937-5972, 8069-8216): not on the call path.
   9. SWITCH, calibration bookkeeping: startCalibration (295) and localBroker (1967) call markProfileUsed with the active profile name; the per-walk localBroker marks the TARGET name so calibration trigger 2 watches the local profile.
   DECISION: option X = PER-WALK DEPS. Refactor providerDeps into makeProviderDeps(profile, backend) (one source for the 12 fields; the boot object is makeProviderDeps over activeResolved and currentBackend, the fallback one is made over the target and a backend built ONCE with makeBackendFromProfile, which bumps RELOAD_VERSION as a side effect [V, index.ts:~770], so build it once per fallback). walkProfileChainOnce already takes deps as a parameter (index.ts:3414 [V]) and chatCompletionWithRetry takes deps, so no signature changes. REJECTED Y (overrideActiveProfile, index.ts:1084): it swaps activeResolved, routing, free state, SOFT_TIMEOUT and currentBackend mid-command (index.ts:1008-1049 [V]), so the spend guard would judge in-flight remote requests against the local profile. REJECTED the earlier idea of a latch object read by the globals: it leaves 11 of the 12 fields on the remote profile. The latch (below) only remembers that this command went local.

## Required tests

 Proof = the full existing suite passes unchanged (no test edited to fit). Optional [I], one focused test: makeProviderDeps over a profile other than the active one reads that profile for each of its fields, and the boot deps still equal makeProviderDeps over the active profile.

## Approval log

- 2026-11-13T19:11:18+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T18:56:54+0100 — column → dev by main-agent@llm-externalizer-plugin. dispatched to a worker 2026-11-14
- 2026-11-14T19:58:57+0100 — column → testing by main-agent@llm-externalizer-plugin. landed ca2c097f; full suite owed at the pre-push run
- 2026-11-16T20:15:26+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (squash c4dc6bd5) and v14.4.0; acceptance boxes checked against the v14.4.0 source and the green full npm test of the v14.4.0 publish.

## Notes

2026-11-14T19:58+0100 landed as ca2c097f (src/index.ts, vitest.config.ts, dist, new src/provider-deps-seam.test.ts). Main agent read the src diff: the inlined timeout and context fallback equal SOFT_TIMEOUT_MS and FALLBACK_CONTEXT_LENGTH, both assigned from the same profile in the settings swap (index.ts:736-737, 1062-1063). Worker-reported: tsc, eslint, build pass; the two seam test files pass 10/10; a killed full run showed 5 failures from the missing better-sqlite3 binding (TRDD-G0MS9B63) and 1 in governor-load.test.ts, which does not import index.ts (read, not rerun). The full-suite proof moves to the pre-push run (owner rule 2026-11-14: tests only before a push; RL-02 TRDD-6PIGEAN0).

## Acceptance

- [x] makeProviderDeps(profile, backend) and localSizingFor(profile, tool) exist and are the one source (ca2c097f; present in v14.4.0 source, checked 2026-11-16T20:15:14+0100)
- [x] seam test src/provider-deps-seam.test.ts ships in v14.4.0
- [x] the full npm test passes: v14.4.0 publish run 2026-11-16, all 4 stages green (6334, 221, 12, 1 passed), the card's stated proof of no behaviour change
