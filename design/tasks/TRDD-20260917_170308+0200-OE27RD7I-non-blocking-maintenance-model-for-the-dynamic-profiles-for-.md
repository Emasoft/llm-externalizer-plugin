---
trdd-id: OE27RD7I
status: tasked
title: non-blocking maintenance model for the dynamic profiles for 14.1.0
column: todo
created: 2026-09-17T17:03:08+0200
updated: 2026-10-07T17:18:11+0200
current-owner: coordinator-session-2026-09-17
created-by: coordinator-session-2026-09-17
task-type: feature
min-approval-requirement: none
assignee: coordinator-session-2026-09-17
mandate: true
mandated-by: none
approved: true
approval-judge: coordinator-session-2026-09-17
approval-datetime: 2026-09-17T17:03:08+0200
release-via: publish
target-release: 14.1.0
scope: project
project-id: llm-externalizer-plugin
relevant-rules: []
implementation-commits: [a24012d, fe9b88c, 5f3f370, 8e98872, a6fec0c, f0bb09a, 5842393, 3c7aaaf, d0c67e63, 87b02c9a]
---

# non-blocking maintenance model for the dynamic profiles for 14.1.0

Non-blocking maintenance model for the dynamic profiles for 14.1.0 (fix-queue row 88). See code map at llm-externalizer-plugin/reports/llm-ext-release/20260917_194500+0200-fq88-active-and-local-map.md.

## Approval log

- 2026-09-17T17:03:08+0200 — MANDATE issued by coordinator-session-2026-09-17 (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Directive

USER 2026-09-17 ~20:05, verbatim: "also remember that the llm-ext will not do the updating/benchmarking automatically at every execution. that would make llm-ext extremely slow to start. instead it will execute the current profile first, and if there is an issue, like missing models or endpoints, it will trigger the updating procedure of the current selected profile. if no error happens, the llm-ext will execute the current profile, but while it will be executed, another process in parallel will be spawn to check if there are changes (new models, removed models, changed costs, new/updated local endpoints, etc. depending on the selected profile) and if the changes are detected then always in parallel another process will be spawn to run the updating/scanning/benchmarking/etc. of the profile, so that even if the current profile don't return errors, it will be updated as soon as possible."
The 14.0.0 question this raises is recorded on TRDD-90DM5YHO's STATE (USER decision pending).

## Rule

SUPERSEDED — see "## Rule (consolidated 2026-09-17)" below for the current, single text; this section is kept for history only.
For every dynamic profile (free, paid, local): (1) the command runs the currently selected profile as written on disk, with NO in-process catalog/endpoint check before it;
(2) if a model fails (missing model, dead endpoint, 402/404 class), the command switches to the NEXT benchmarked model of the SAME profile in benchmark-rating order over the validated list written in the profile (for local: the profile's detected-endpoint order until C9SXX7HO decides its list shape), spawns the profile's update in the background, and continues; it prints that it is updating the profile due to changes and is WAITING for that update, then BLOCKS until the update completes, ONLY when every benchmarked model in the profile has failed — deliberately the narrower of the directive's two phrasings (the list written in the profile, not any model anywhere). Reuse free-rotation.ts, completion.ts mid-flight fallback (fix-queue 14) and classifyError (fix-queue 3), fixing them where rows 3/14 say they are wrong; do not add a second rotation.
(3) otherwise, alongside the run, ONE detached change-detection process is spawned (new/removed models, changed costs, new/updated local endpoints, per the profile's kind);
(4) if it detects a change it spawns, still detached, the update/scan/benchmark of that profile, so the on-disk section is refreshed for the NEXT command.
Nothing in (3)/(4) delays or blocks the current command.
Existing pieces to reuse: default-profiles-runner.ts (detached child), dynamic-maintainer.ts fingerprints (the change detector's content), the populator bench lock (duplicate-spawn guard).
Cards A and B do not list C in npt; they can land before C, but B's regenerated when endpoints change wording is implemented by C's mechanism, so B cites C in its body.
(2) above is the revised step; the pre-addendum-2 wording is preserved only in the Directive sections.
COORDINATOR READING: step (1)'s no in-process catalog/endpoint check is stronger than the directive, which forbids updating/benchmarking on the command's path, not a cheap check; confirm with the USER before implementation.
STATIC profiles (every profile that is not free/paid/local): no update procedure is ever triggered; on any model failure (error, unreachable endpoint, 402 exhausted credits) the command switches to the next model listed in the selected profile, in the order listed; a model outside the selected profile is never used; when the listed chain is exhausted the command exits non-zero with: the models in the selected profile are all failing; retry later or change the profile. Fix-queue rows 3 and 14 are the two 14.0.0 code paths that violate this (hard-coded free fallback on 402 for a static profile) and are tracked on TRDD-90DM5YHO.
INVARIANT (addendum 4): the profile selected at command start is fixed for the whole command; no cross-profile borrow of any kind (402 → free, paid → free, remote → local, runtime FREE_MODEL_ID / FREE_POOL_SEED) survives; exhaustion means exit for a static profile and the blocking update for free/paid/local; no exceptions, no env opt-out.
COORDINATOR READING of addendum 4's no exceptions: the invariant's no env opt-out and its four named borrows (402 → free, paid → free, remote → local, runtime FREE_MODEL_ID / FREE_POOL_SEED) are the coordinator's enumeration of what the code does, not the USER's words.

## Inventory

Code map (P6d spec's step 2 timings as the acceptance baseline): llm-externalizer-plugin/reports/llm-ext-release/20260917_194500+0200-fq88-active-and-local-map.md
scripts/llm-ext/src/index.ts:~3400 (the in-process maintainDynamicProfiles call inside dispatchCallToolInner, gated by RECONCILE_SKIP_TOOLS) — becomes a detached spawn.
scripts/llm-ext/src/dynamic-maintainer.ts:226-772 — split into detector (fingerprint compare) and updater.
scripts/llm-ext/src/default-profiles-runner.ts — the spawn primitive.
scripts/llm-ext/src/model-reconcile.ts — the error-path missing model signal.

## Acceptance

Any command's wall time with a populated profile is unchanged by the maintainer: median of 10 runs of `llm-ext settings status` with and without LLM_EXT_DISABLE_AUTO_RECONCILE differ by less than 100 ms, and no network call is made before the profile's first request (asserted by a network-injected test).
A profile whose model: was removed from the catalog: the command reports the error AND the next command sees a repaired section.
With a changed catalog and a healthy profile: the command succeeds unchanged; a detector process appears in a ps snapshot; the section is updated before the following command.
- [x] P2 slice (rows 96(1)(2)(3), 97, 98(4d)): pre-landed 2026-09-18 as 1d1993f + reviews 23be356/6e220f4 (dogfood three-section bootstrap, throttle-from-original-stamp pin, non-array local queue loud, endpoint-dead baseUrl pin, absence-marker iteration); worker verified at HEAD 2026-10-04: tsc 0, eslint 0, vitest 43/43 three legs, NUL 0, dogfood 111 PASS / 0 FAIL / 1 WARN / 1 SKIP in isolated config dir, dist determinism gate PASS
- [x] P1 slice (rows 98(1)-(5), 89, 90, 95b/96(4), 92): items 1-9 verified as pre-landed (5dd9fe1, 683a65e, cb40152 + reviews 0a49eaa, 6b283d6); the two genuine test gaps closed (98(2) static-with-:free + built-in-free-head pins in index.test.ts:1722 with red proofs on ca899af; 98(3) redirect-naming title honest-402.test.ts:324) — commit b8cda35; coordinator reran index -t :free 6/6, honest-402 4/4; one pre-existing load-sensitive CLI-timeout flake confirmed on pristine HEAD (report reports/llm-externalizer/20261004_142918+0200-oe27rd7i-postc2c-p1.md)

## Directive addendum 2

USER 2026-09-17 ~20:40, verbatim: "But the llm-ext must try (best effort) to execute the current profile as soon as possible, and to be resilient in case of missing models by switching to the next benchmarked model available in the profile to replace the model that was returning error, using the benchmarks rating as order of priority for the fallback. only if no model is found working at all, the llm-ext must print the message that it is updating the profile due to changes, causing a real delay until the update is completed. but it must do its best effort to run at least one model immediately, and executing the update in background without blocking the command. only if there is truly not a single model working in the list of benchmarked models validated and written in the profile, it must be blocking and force the wait."

## Directive addendum 3

for normal profiles (those created by the user, not the included 3 defaults free/paid/local) instead, no update procedure must be triggered at all. even if a model fails or an endpoint is unreachable or has exhausted credits, it will simply switch to the next model listed in the selected profile. in no case models outside the selected profile must be used. normal profiles are not dynamic and stick to the manually defined list of endpoints and models defined in it. if not even one model works after the fallback chain, the llm-ext simply exit with an error message sating that the models in the selected profile are all failing, and to retry later or change the profile.

## Directive addendum 4

USER 2026-09-17 ~21:50, verbatim: "no switching to free models (or local models) must exist anymore. llm-ext must stick to the selected profile in --profile <profile name> (or free profile if omitted). no change of profile must be allowed once the command is executed. if no fallback is found working in a profile, llm-ext will exit with error (for normal profiles) or trigger the updating processes (if the profile is one of the 3 dynamic integrated profiles:nfree/paid/local). no exceptions."

## STATE

C1 landed a24012d (profileChain + ProfileExhaustedError; completion.ts and free-rotation.ts stripped of every cross-profile borrow) and fe9b88c (five tests now pin the absence); C2 (chain wiring, exhaustion handling, detached detector/updater, deletion of the auto-free-mode env readers) in progress.
2026-09-17 ~22:30: C2b core 5f3f370+8e98872, C2a chain wiring a6fec0c+f0bb09a, C2b-WIRE 5842393, C2c-ENV 3c7aaaf (the automatic-free-mode machinery deleted outright — no balance pre-flight, no 402 switch, no env override; harness sweep 0 hits). Lazy resolution NOT done: the allow-list ships by decision (see G6XT3AY9). Open: C2 spec owed items (rows 89, 90, 92, 95, 96) in the post-C2c slice.
2026-10-04: this card's addendum-4 invariant (no cross-profile borrow, detection only) REVERSES TRDD-542BDBEF (auto-engage free mode under $1 balance); 542BDBEF is terminal/frozen and is left unedited per O2DJD8WM.
2026-10-07: all triage rows done or disposed; the card's own Open fix-queue rows and post-C2c rows 89-97 are being re-checked before closing.

## Rule (consolidated 2026-09-17)

For every dynamic profile (free, paid, local): (1) the command runs the currently selected profile as written on disk, with NO in-process catalog/endpoint check before it; (2) if a model fails (missing model, dead endpoint, 402/404 class), the command switches to the NEXT benchmarked model of the SAME profile in benchmark-rating order over the validated list written in the profile (for local: the profile's detected-endpoint order until C9SXX7HO decides its list shape), spawns the profile's update in the background, and continues; it prints that it is updating the profile due to changes and is WAITING for that update, then BLOCKS until the update completes, ONLY when every benchmarked model in the profile has failed — deliberately the narrower of the directive's two phrasings (the list written in the profile, not any model anywhere); reuse free-rotation.ts, completion.ts mid-flight fallback (fix-queue 14) and classifyError (fix-queue 3), fixing them where rows 3/14 say they are wrong, do not add a second rotation; (2) is the revised step, the pre-addendum-2 wording is preserved only in the Directive sections. (3) otherwise, alongside the run, ONE detached change-detection process is spawned (new/removed models, changed costs, new/updated local endpoints, per the profile's kind); (4) if it detects a change it spawns, still detached, the update/scan/benchmark of that profile, so the on-disk section is refreshed for the NEXT command; nothing in (3)/(4) delays or blocks the current command. Existing pieces to reuse: default-profiles-runner.ts (detached child), dynamic-maintainer.ts fingerprints (the change detector's content), the populator bench lock (duplicate-spawn guard). Cards A and B do not list C in npt; they can land before C, but B's regenerated when endpoints change wording is implemented by C's mechanism, so B cites C in its body. COORDINATOR READING: step (1)'s no in-process catalog/endpoint check is stronger than the directive, which forbids updating/benchmarking on the command's path, not a cheap check; confirm with the USER before implementation. STATIC profiles (every profile that is not free/paid/local): no update procedure is ever triggered; on any model failure (error, unreachable endpoint, 402 exhausted credits) the command switches to the next model listed in the selected profile, in the order listed; a model outside the selected profile is never used; when the listed chain is exhausted the command exits non-zero with: the models in the selected profile are all failing; retry later or change the profile. Fix-queue rows 3 and 14 are the two 14.0.0 code paths that violate this (hard-coded free fallback on 402 for a static profile) and are tracked on TRDD-90DM5YHO. INVARIANT (addendum 4): the profile selected at command start is fixed for the whole command; no cross-profile borrow of any kind (402 → free, paid → free, remote → local, runtime FREE_MODEL_ID / FREE_POOL_SEED) survives; exhaustion means exit for a static profile and the blocking update for free/paid/local; no exceptions, no env opt-out. COORDINATOR READING of addendum 4's no exceptions: the invariant's no env opt-out and its four named borrows (402 → free, paid → free, remote → local, runtime FREE_MODEL_ID / FREE_POOL_SEED) are the coordinator's enumeration of what the code does, not the USER's words.

## 14.1.0 schema slices

D3c coordination (owned in full by TRDD-FDI9NYAS): after D2 (already committed) this cards background detector childs maintainer pass is the ONLY writer for filterFreeModels no-provisional-pool eligibility - implement the recorded-pass requirement here when FDI9NYAS lands its D3c gate, do not let this maintainer serve a provisional catalog pool.
D2 follow-ups (coordinator/worker defaults, NOT USER decisions - full text on TRDD-DS6OM3KX): a 401 among 401/certain-402 causes on any profile is a key error with no update, 401+402 together is a key error, respawn window 30 minutes; the update-requested marker waits out an active failure backoff of 15 minutes to 24 hours, so the retry-later "will be finished soon" wording can be false for up to a day - the actual wording fix ships in TRDD-FDI9NYAS (D3c).
N-pass carry: Detector fingerprint one-pass lag (D2 report section F1).
SG2b-3 (plan item 10): singleton test strength SF-1/SF-2/SF-6, NIT-3/4/6/7, and the README note "per config dir" for the one-background-process-per-profile singleton (commit a577cdf).
C1b (plan item 10): index.ts nits; re-read against the D2 boot-call changes.
C8 test hygiene (plan item 10): tests must not write the real ~/.claude/rules/use-llm-externalizer.md, and must not leave /tmp/__llm_ext_* or llm-ext-driver-cooldowns-* directories behind.
See TRDD-DS6OM3KX for the USER decisions and accepted schema this slice implements.

## Follow-ups carried from 38QAM06E

no-catalog-lookup assertion (from 38QAM06E STATE, unfixed as of 2026-09-23): dynamic-candidates.ts's pruneUnroutedFreeCandidates classifies purely from routeByModel/':free' suffix and never calls the catalog fetcher, but no test asserts this invariant (e.g. 'pruneUnroutedFreeCandidates never calls fetchCatalog') — add one so a future edit cannot silently reintroduce a catalog dependency.
benchmark-vetted label (from 38QAM06E Root cause 2, unfixed as of 2026-09-23): index.ts:4312 labels the free pool 'benchmark-vetted' by reading activeFreePool()/approvedFreePoolFromSettings() — the WRITTEN free_models list — not a live population/maintenance-state check. This is only true by construction (dynamic-candidates.ts's queue design writes survivors post-benchmark only, per TRDD-F1I95989 AC2), never verified at the label call site itself; add an explicit population-state check (e.g. last-maintained timestamp / no-stale-queue assertion) before trusting the label.
2026-10-05 from CE9B7S8N's implementation review (transferred BEFORE CE9B7S8N archival per the 12ed51c0 precedent): ACCEPTED follow-up — an unbooked child death (dies before recordBenchmarkFailure books anything) now respawns on every maintainer pass with no floor (inherent to CE9B7S8N's acceptance: the old spawn-stamp bounded a crash-loop to 1/6h). Fix shape: a cheap unbooked-retry floor (~15 min) read from a spawn-attempt marker. Not a redesign.

## Open fix-queue rows (from D3c-2 review)

F2 (MINOR, review of 96a03d7): re-sync the check-imports fixture benchmark-fixtures/check-imports/src/free-rotation.ts (last synced Aug 29; live free-rotation.ts now imports paymentErrorCertainty from benchmark/free-mode.js after the D3c-2 leaf move, so the layering oracle validates a shape that no longer exists). F3 (MINOR, same review): getActiveFreeOnly() UNSET->true fail-closed default is silent - add a one-line stderr note on first serve of the UNSET default, or a contract comment at the definition naming the invariant (every CLI main() publishes before any spend site).
D4-review-filing F-4 row: the E-D1 blind spot from the D4 review's coupling analysis never became a filed row — a user-owned local section that keeps ONLY the legacy providers key after hand-cleanup (deleting detected_providers) makes local resolution read nothing: the user's detected routes are silently unused forever and E-D1 (the closed-key-set validator) stays silent because the section carries no unknown key. Fix shape: E-D1 or the migration should notice a MARKED local section with providers but no detected_providers even when the migration step is already stamped, and warn. Source: D4 review answer 5, filing review F-4.

## Open fix-queue rows (from D6a review)

F4 (NIT, review of a140016): getActiveBillableForModel's empty-serving -> backend-billable branch is unreachable in production (resolveGroups always emits group #0) — document as test-stub-only or assert. F5 (NIT, same review): no named test covers the native-flavor (llama.cpp) probe for a SECONDARY local group through the routed path — add one to route-headers or connection suite.

## Open fix-queue rows (transferred from archived TRDD-90DM5YHO 2026-10-04)

Row 79: chainModelIds re-derives resolveProfile's static free_only rule instead of reading resolveProfile's own resolved surfaces (desync risk on the next rule change); same gap for high_quality_model.id. Fix: derive the chain from resolveProfile's output, or gate high-quality-scan like tool_models, with pinning tests.
Row 80: dynamicProfileGate's paid 'pool is empty' arm may now also see free_models/tool_models, so a paid section with a placeholder model plus a populated free_models could wrongly show the placeholder-sentinel error instead of naming the population state (unverified). Fix: pin a maintainer test for that shape and correct the arm order if it fails.
Row 84: the P6d claim that paid populator spend was $0 is inferred, not measured; the E1 re-run (WBZJRSQB step 11) must measure the API's total-usage delta before/after, and re-run the maintenance-disabled wording check on a fresh copy before any dispatch. Owned jointly by OE27RD7I (measurement method) and WBZJRSQB step 11 (the run itself).

## Row status 2026-10-07 (reconciled against HEAD 87b02c9a)

Row 1: DONE - 6d9fffe; default-profiles.ts benchmarkPassed.has, dynamic-maintainer.ts passes benchmarkPassedModels.
Row 2: DONE - index.ts:1966-1969, default-profiles-runner.ts:402, default-profiles-state.ts:135, profile-fallback.ts:88-102 (96a03d7).
Row 3: DONE (accepted, documented) - dynamic-maintainer.ts:612-623 comment "Not a bug".
Row 4: DONE - 32667db8 + 7afb6056; background-singleton.test.ts:24-25,129,151,167.
Row 5: DONE - profile-detector.test.ts:500-501,532.
Row 6: DONE - 32667db8; bench-spawn.test.ts:404-411, bench-spawn.ts:135.
Row 7: DONE - default-profiles-runner.ts:313-322.
Row 8: DONE - 90785d31; lockPathFor/detectLockPathFor aliases deleted, callers use backgroundUpdateLockPathFor.
Row 9: OBSOLETE - runDynamicProfileUpdateAndWait removed with D2.
Row 10: OBSOLETE - foreground claim removed from index.ts.
Row 11: DONE - no default-profile-*.lock label left in dispatch-reload.test.ts.
Row 12: DONE - 90785d31; bench-spawn.ts:220-221 releases only if owner null or process.pid; bench-spawn.test.ts:417-431.
Row 13: DONE - 41e36a0e; README.md:1060 "per profile (free, paid, local) per config directory".
Row 14: DROPPED - see Coordinator decisions 2026-10-07 (no nit is enumerated anywhere, so no defined work).
Row 15: DONE - 90785d31; test-hermetic-config.ts:40-42 sets LLM_EXT_INSTALL_RULE ??= "0"; rule-install.test.ts:46-49.
Row 16: DONE - test-tmpdir-tracker.ts wired at vitest.config.ts:17 (no /tmp snapshot after a full run taken).
Row 17: DONE - c67fd33e; dynamic-candidates.test.ts:12-23 and :254 "readCandidates pruning never consults the model catalog".
Row 18: DONE - 41e36a0e + d0c67e63; index.ts:4478-4485 poolVetting labels; index.test.ts:1336-1404.
Row 19: DONE - 87b02c9a; dynamic-maintainer.ts:236 SPAWN_ATTEMPT_FLOOR_MS 15 min, :739 floor; bench-spawn.ts spawn-attempt marker; tests dynamic-maintainer.test.ts:245-298 and bench-spawn.test.ts.
Row 20: KEPT FROZEN - see Coordinator decisions 2026-10-07 (fixture is a deliberate verbatim snapshot).
Row 21: DONE - config.ts:3700-3716 comment + config.test.ts:90.
Row 22: DONE - d0c67e63; benchmark/pick.ts:1527,1722-1735 warns once per process (legacy providers-only local section); profile-migration.test.ts.
Row 23: DONE - 41e36a0e; config.ts:3764 comment "Reachable only from test stubs"; branch kept.
Row 24: DONE - c67fd33e; provider/connection.test.ts:243-260 secondary local route.
Row 25: DONE - ff2a929c; config.ts:1751 blanksToolModelsUnderFreeOnly used at :1819/:3340; config.test.ts:404-411.
Row 26: DONE - 52f3e6aa; dynamic-maintainer.test.ts:2440 "row 80: paid arm order with a non-empty free_models slot".
Row 27: NOT-CODE - usage-delta measurement is owned by TRDD-WBZJRSQB step 11a.

## Coordinator decisions 2026-10-07 (USER may override)

Row 14 (C1b index.ts nits vs D2 boot-call) dropped: no card, plan or report enumerates any nit, so there is no defined work; reopen as a new card if a concrete nit is found.
Row 20 (check-imports fixture re-sync) kept frozen: the fixture is a deliberate verbatim snapshot; re-syncing it would change pinned counts and invalidate recorded benchmark scores.

## Commit message corrections (do not amend)

87b02c9a (row 19) says every new assertion was shown red; the path-identity test and the setup control (case b) had no red proof.
