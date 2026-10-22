---
trdd-id: AL8GIZYA
title: D0 ownership boundary and user key preservation for dynamic profiles
column: complete
created: 2026-09-23T11:19:26+0200
updated: 2026-09-24T01:23:50+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-23T11:19:26+0200
implementation-commits: [ecf1eaa, 9409c9c]
---

# D0 ownership boundary and user key preservation for dynamic profiles

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-24
D0 core COMMITTED ecf1eaa: per-profile DYNAMIC_GENERATED_KEYS / DYNAMIC_USER_OWNED_KEYS (providers generated on free and local until D5 and D6a, user-owned on paid early), per-key writer, writeDynamicUserKeys, migrateSettingsTo141 step price-ceiling-into-paid, E-D1 / E-L1 / E-S1 / E-D3 (two messages), boot-order test. Full suite green on three env legs before the last fix-up; 2942 passed after it.
Disclosed in the commit: hand-added ensemble_pins, timeout, context_window, app_name, http_referer on a generated section are refused from ecf1eaa until the D5 dynamic-unknown-keys migration; the migrate-141 unit tests are only import-red on HEAD.
D0-flows COMMITTED 9409c9c: every auto-pick discovery path and benchmark reads getEnsemblePriceCeiling() (a filterModels backstop had silently re-capped custom ceilings above 1.30 USD per million); --include and --code-task models are exempt from the benchmark price refusal only; the incumbent stays gated; paid_models is written through pickEnsembleByPriceCeiling, so an over-ceiling hand-named model never becomes an auto-pick; free_only runs skip non-zero-cost models before sending (runner.ts).
Measured 2026-09-24 after a fresh npm run build on ecf1eaa plus 9409c9c: full suite 2945 passed, 5 skipped, 0 failed on all three env legs; pytest 211 passed. D0 is complete.

## Approval log

- 2026-09-23T11:19:26+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-24T01:23:50+0200 — COMPLETE by agent. archived → complete.

## Scope

Slice D0 (release plan item 2): ownership boundary and user-key preservation for the free/paid/local generated sections. Ships FIRST, before D3b. Spec: 20260918_182438+0200-profile-yaml-design.md section 6 D0.
Files: config.ts (DYNAMIC_GENERATED_KEYS / DYNAMIC_USER_OWNED_KEYS, Profile.selection, validateProfile closed-key check E-D1/E-L1/E-S1, loadSettings ceiling migration, settingsLevelErrors E-D3, getEnsemblePriceCeiling body, remove Settings.ensemble_price_ceiling_usd_per_million, reservedDynamicProfileNameError text, banner); benchmark/pick.ts (writeDynamicProfileSection per-key merge, writeDynamicUserKeys, migrateSettingsTo141 with step price-ceiling-into-paid); default-profiles-state.ts (migrationsApplied carried through the reader, markMigrationStepApplied); dynamic-maintainer.ts (regeneration path validates user keys first, fixes the unpopulatedFreeProfile/unpopulatedPaidProfile choice); index.ts (boot call).
Also required (plan item 2 sub-items): (a) every auto-pick discovery flow reads the resolved ceiling, runKeywordSweep and the six per-tool benchmarks too, no 1.3 literal reachable at runtime, discover.ts literal only as a drift-guarded fallback; (b) models named explicitly for a benchmark via --include or --code-task are manual, assertModelsUnderPriceCap must not refuse them; (d) keep DEFAULT_ENSEMBLE_PRICE_CEILING_USD_PER_M and getEnsemblePriceCeiling signature unchanged; (e) a test that paid populate sends are charged against paid_benchmark_daily_cap_usd, naming the real gate; fix cli-args.ts help text "strictly less" to "<=" and the security-triage select.ts comment.
Tests required: a user selection block and its comments survive the free childs () => next rewrite and the maintainers patch write, byte for byte; E-D1 refuses a misspelt key; the price ceiling moves exactly once; the ambiguous ceiling case (both top-level and profiles.paid.selection set with different values) leaves the file unchanged and refuses the command.
Merge note (design section 6 D0): D3a already landed on main (touches config.ts near getEnsemblePriceCeiling, adding the D3c predicate) - D0 only changes that functions body, so this is already satisfied on current HEAD.
Order: after D2 (already committed), before D3b. See TRDD-DS6OM3KX for the USER decisions and accepted schema this slice implements.

## Acceptance checklist

- [x] a user selection block and its comments survive both writing shapes byte for byte (scripts/llm-ext/src/benchmark/pick-comment-preservation.test.ts:368)
- [x] E-D1 refuses a misspelt key on a dynamic profile (scripts/llm-ext/src/config.test.ts:2038)
- [x] the price ceiling moves exactly once (fresh boot migrates the top-level ceiling into profiles.paid.selection and deletes the top-level key) (scripts/llm-ext/src/index.test.ts:1355)
- [x] the ambiguous case (top-level and profiles.paid.selection set to different values) leaves the file byte-identical and settingsLevelErrors refuses with E-D3 (scripts/llm-ext/src/benchmark/migrate-141.test.ts:112)
