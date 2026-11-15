---
trdd-id: 3CG178O7
title: Typed remote failure causes in free-rotation and a network-level failure classification
column: testing
status: tasked
created: 2026-11-13T19:10:42+0100
updated: 2026-11-15T17:23:12+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T19:10:42+0100
derived: true
parent-trdd: UT7UC025
implementation-commits: [d6fad12e]
blocked-by: []
unblock-when: [trdd:G0MS9B63]
blocker-probe: 'grep -rqE ''^column: (complete|completed|cancelled)$'' design --include=\*G0MS9B63\*'
blocker-holds-if: exit-nonzero
pre-block-column: 
---

# Typed remote failure causes in free-rotation and a network-level failure classification

## Origin

Increment 1a of TRDD-WSPV40Y5 (automatic fallback of general commands to a ready local profile). Split out of WSPV40Y5 in revision 3 after the final review; the text under the Moved headings is moved verbatim from WSPV40Y5 revision 2. In moved text, section numbers and Qn refer to WSPV40Y5, and 1a 1b 1c 1d are the four increments (1d = WSPV40Y5 itself, the fallback helper; it consumes 1a, 1b and 1c, so they land first). Markers: [V] = VERIFIED, file:line read in the card session; [I] = INFERRED, the implementer must read it before relying on it. All paths under scripts/llm-ext/src/. Parent: TRDD-UT7UC025. One commit.

## Scope (1a)

Behaviour change limited to clearer error messages: no fallback, no retry change, no new setting, no probe.
 1. Typed causes through the free rotation: callWithFreeRotation (free-rotation.ts:1339-1500) collects each model failure as a typed cause (a causes array pushed at the rotate point, free-rotation.ts:~1485-1495), carried on AllFreeModelsExhaustedError (free-rotation.ts:1406-1410) and passed by freeRotationExhausted (index.ts:3295-3299) in place of the bare Error built from lastDetail.
 2. Fix the raw rethrow at free-rotation.ts:1462: a network-isolation failure leaves the rotation after the FIRST model today as an untyped raw error. The exit point stays where it is [I]; only the thrown error becomes typed, so the typed cause list reaches the catch of every free call site (callSingleWithFreeRotation index.ts:3365-3367, chatCompletionJSONWithFreeRotation index.ts:3405-3407).
 3. Trigger (c) as a PURE classifier function (exact name and file are the implementer choice [I]): input = the typed causes, output = true when every cause (at least one) carries a typed networkCode in NETWORK_ISOLATION_CODES = OUTAGE_NETWORK_CODES (index.ts:2203-2212) minus ETIMEDOUT-LOCAL. No probe and no I/O: the STRICT probe is TRDD-WSPV40Y5 1b, and the fallback decision that combines both is 1d.

## Moved from WSPV40Y5 section 2: trigger c, definition and why it is needed

 c. NETWORK ISOLATION, independent of model count (NEW, required by review): every cause (at least one) carries a typed networkCode in NETWORK_ISOLATION_CODES = OUTAGE_NETWORK_CODES (index.ts:2203-2212 [V]) minus ETIMEDOUT-LOCAL, AND the STRICT probe does not return a genuine provider answer.
   WHY it is needed [V]: one network failure makes endpointFailureKind return endpoint (broker/client.ts:117-123; it is a regex on the failure text: ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed), the walk then marks the base URL dead for the rest of the walk (profile-fallback.ts:258) and skips every other entry on that URL, so a single-endpoint profile ends with ONE cause, and detectProviderOutage needs at least 2 distinct models (index.ts:2246) and answers undefined. Today that very failure falls to the update branch of failDynamicProfile and starts a pointless updater. Trigger a alone therefore never fires for no-network on OpenRouter.
   Where causes carry the code [V]: FailureFields.networkCode (provider/http.ts:581), attached in the fetch retry loop catch (http.ts:~377, networkCodeOf http.ts:~718-735) and read through failureOf (http.ts:643) exactly as providerSideFailure does (index.ts:2216-2231). On the free path the RAW error carries networkCode but NOT modelId or baseUrl (profile-fallback.ts:~260-266 attaches those only inside the chain walk), so the probe base URL comes from the active profile or the route (profile.url), never from the cause.
   ETIMEDOUT-LOCAL (the request own timeout abort, http.ts:~722) does NOT count for c: a slow model on a big prompt is not a dead network. It still counts for trigger a, which also needs 2 models and a failing probe. UND_ERR_CONNECT_TIMEOUT, ENETUNREACH and EHOSTUNREACH do count (already in OUTAGE_NETWORK_CODES).

## Moved from WSPV40Y5 section 2: free-path exits and the typed-cause carry

   FREE-PATH EXITS of callWithFreeRotation [V, free-rotation.ts:1339-1500]: closed shared window rethrown at 1383 and 1449; command stop at 1451; a failure that is neither an availability verdict (classifyUnavailable, free-rotation.ts:563, read in full: no pattern matches ECONNREFUSED, ENOTFOUND or fetch failed) nor a certain payment error is rethrown RAW at 1462, so network isolation leaves the rotation after the FIRST model and never reaches the pool-exhausted throw AllFreeModelsExhaustedError at 1406-1410. freeRotationExhausted (index.ts:3295-3299 [V]) passes a raw error through unchanged and wraps an exhaustion as ONE bare Error built from lastDetail, with no networkCode, modelId or baseUrl. CONSEQUENCE: at the free sites trigger c reads the raw error in the catch; triggers a and b cannot be evaluated on an exhaustion until callWithFreeRotation also collects each model failure as a typed cause (a causes array pushed at the rotate point, free-rotation.ts:~1485-1495, carried on AllFreeModelsExhaustedError and passed by freeRotationExhausted in place of the bare Error). That carry is part of increment 1; if the implementer drops it, free covers trigger c only and the card must say so.

## Moved from WSPV40Y5 section 7: risk

 - Free path before the typed-cause carry: only trigger c; no 5xx outage fallback on free (section 2).

## Required tests (agent proposal [I], real servers and real processes, no mocks)

 1. Pure unit tests of the classifier: each code in NETWORK_ISOLATION_CODES gives true; ETIMEDOUT-LOCAL gives false; a cause with no networkCode gives false; a mixed list gives false; an empty list gives false.
 2. A real closed port through callWithFreeRotation: the thrown error carries the typed cause (networkCode ECONNREFUSED) and its message names it; the exit point is unchanged (the rotation still stops after the first model).
 3. Pool exhaustion with real node:http servers answering 503: AllFreeModelsExhaustedError carries one typed cause per model tried, and freeRotationExhausted passes them on.
 4. Proof of no other change: the full existing suite passes unchanged apart from the assertions on the changed error messages.
 The end-to-end cases of WSPV40Y5 section 6 that exercise the fallback itself (one-model no-network answered locally, free profile answered locally) stay in 1d.

## Approval log

- 2026-11-13T19:10:42+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T17:46:04+0100 — column → dev by main-agent@llm-externalizer-plugin. dispatched to a worker 2026-11-14
- 2026-11-14T18:49:41+0100 — column → testing by main-agent@llm-externalizer-plugin. implemented in d6fad12e; full npm test owed after the sqlite binding fix
- 2026-11-14T18:50:57+0100 — column → blocked by main-agent@llm-externalizer-plugin. only the full npm test remains, and it cannot pass until the better-sqlite3 binding is rebuilt (TRDD-G0MS9B63, user action)
- 2026-11-14T20:00:26+0100 — column → testing by main-agent@llm-externalizer-plugin. owner rule 2026-11-14: tests run only before a push; required test 4 (full npm test) moves to the pre-push run RL-02 Cleared blocked-by (--clear-blocker override).

## Acceptance

- [x] Required tests 1-3 (classifier units; closed port gives a typed ECONNREFUSED error after one model; three 503 models give three causes passed on), each of 2-3 failing before the change (d6fad12e).
- [x] Routing unchanged: the exhaustion decision reads the last cause only; a paid [429, then 402] pool still returns the credit verdict, pinned by a test that failed on the first draft.
- [ ] Required test 4: the full npm test passes unchanged. Blocked by the missing better-sqlite3 native binding (TRDD-G0MS9B63); the scoped areas pass, and broker.test.ts and dispatch-reload timeouts under parallel load pass serially or alone.

## Notes

2026-11-14T18:49:40+0100: d6fad12e. The card's example of a mixed exhaustion with a 401 cannot happen: classifyUnavailable never rotates past an API error 401, so a 401 leaves the rotation raw. The first draft let every cause drive failDynamicProfile; that widening was taken out, as this card allows message changes only. The question of letting every cause drive routing goes to 1d (TRDD-WSPV40Y5). A RetryDeadlineError with a network cause is not typed, by design: several call sites key on instanceof RetryDeadlineError. Worker report: reports_dev/3cg178o7/20261114_181333+0100-implement.md.
2026-11-14T18:51:16+0100: review of d6fad12e. (a) No reader in src of instanceof TypeError, err.name === TypeError, or cause.code sits on the free call paths. The only cause.code reader, mass_scouting/scout-accuracy-fixture.ts:460, calls fetch directly. So the class change to FreeRotationNetworkError changes messages only. (b) causeText (index.ts:2199) reads only .message, and freeFailureCauseToError builds the message as exactly the model detail, so the last-cause decision text equals the old new Error(lastDetail). (c) Moved to blocked on TRDD-G0MS9B63: only the full npm test remains. (d) Broker parallel failures recorded on TRDD-CBOTP0DY.
2026-11-14T20:00+0100 unblocked: owner rule 2026-11-14 (~/.claude/rules/run_tests_only_on_push.md) runs the full suite only right before a push, so required test 4 is owed at the pre-push run (RL-02, TRDD-6PIGEAN0) together with the better-sqlite3 rebuild (TRDD-G0MS9B63); the card stays in testing until that run passes.
2026-11-15T17:22:05+0100 G0MS9B63 binding now loads; box 3 waits only for the pre-push full run RL-02.
2026-11-15T17:23:11+0100 correction to the G0MS9B63 line above: the binding does NOT load (new Database(':memory:') fails with Could not locate the bindings file). Box 3 waits on the native binding (G0MS9B63) and on the pre-push full run RL-02.
