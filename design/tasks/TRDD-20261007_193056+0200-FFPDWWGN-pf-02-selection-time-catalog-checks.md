---
trdd-id: FFPDWWGN
title: PF-02 Selection-time catalog checks
column: blocked
status: tasked
created: 2026-10-07T19:30:56+0200
updated: 2026-10-10T15:07:03+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:56+0200
implementation-commits: [97847fe3, e8d7d255, 0421472e, bf6bdbbd, 21875b8b]
blocked-by: [3ZVURQ58]
pre-block-column: dev
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_193121+0200-3ZVURQ58-pf-06-settings-commands-for-classifier-profiles.md
blocker-holds-if: exit-0
unblock-when: [trdd:3ZVURQ58]
---

# PF-02 Selection-time catalog checks

## Goal
Run the checks that need the decisions catalog when a profile is selected for a run and in `settings validate`.

## Approval log

- 2026-10-07T19:30:56+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:54:05+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T00:54:07+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan
- 2026-10-10T15:06:23+0200 — column → blocked. audit 2026-10-10: selection path committed; step 4 and box E19 need settings validate, which is PF-06 (TRDD-3ZVURQ58, backburner); nobody working it

## Plan refs

§8 (When checked, Decisions guard, Model, Catalog freshness), D9; E19.

## Depends on

PF-01 (TRDD-82LIQI5I), L0-08 (TRDD-MKEWC00E)

## Files

- `scripts/llm-ext/src/config.ts` (selection-time checks)
- decisions-catalog access from L0-08: to be listed at card start
- tests and the vitest include entry: to be listed at card start

## Reuse

- the cached decisions catalog via L0-08
- read the code at card start for the old `typesafe/jev-*` regex being replaced

## Steps

1. Decisions guard: a free, paid or scouting profile whose model appears in the cached decisions catalog (read at any age, never refreshed by this guard) fails when selected; this replaces the `typesafe/jev-*` regex, which missed 13 of 14 models. The guard never fetches the catalog for these profiles, skips local profiles, and is skipped when no cache exists.
2. Model exists: a classifier profile's model must exist in the decisions catalog (alias resolved through `alias_target`); a missing model fails when selected, naming the model and the model-info command's Jev filter (C4-06).
3. Catalog freshness: the cached catalog is used within its TTL; an expired cache plus a failed refresh is an error, not a silent use of stale data.
4. Run these checks when the profile is selected and in `settings validate`; loading settings never touches the network.
5. Add WHY comments.

## Acceptance

- [x] decisions guard works as in step 1
- [x] model-exists check works as in step 2
- [ ] E19: Profile model later removed from catalog → selection error naming the model and the model-info Jev filter
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10 (card stays in dev): committed 97847fe3, e8d7d255 (test include list), 0421472e (rebuilt dist) — classifiers/profile-checks.ts selectionCatalogErrors, l0/catalog.ts readCachedDecisionsCatalog, profile-checks.test.ts (10+ tests). The decisions guard and the model-exists check pass their tests; E19 names the model and the model-info Jev filter. build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. NOT DONE: selectionCatalogErrors is not yet called from the selection path or from settings validate (being wired now), so E19 is not yet reachable as a selection error and the definition-of-done box stays unticked; step 4 (run at selection and settings validate) is open. Notes: only the profile model is checked (not free_models or paid_models); a 3-line cache shape check is still duplicated between l0/catalog.ts and catalog-cache.ts; the old typesafe/jev-* regex does not exist in src, nothing to replace.
RESULT 2026-10-10 (card stays in dev, update): committed bf6bdbbd and 21875b8b in addition to the earlier commits — next to the earlier ticked boxes: implemented and wired at selection; settings validate pending PF-06. The chat guard selectedChatProfileErrors now runs at CLI selection in cli/main.ts (cached catalog only, zero fetches, skipped for commands accepting every type, for a type the command does not accept and for classifier profiles; scouting-only commands check profileOverride ?? effectiveProfile); classifier profiles go through selectClassifierProfile; a bundled-from-source CLI test (profile-accept.test.ts) proves it. build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. STILL OPEN: settings validate does not exist yet (card PF-06, TRDD-3ZVURQ58, step 3 there calls it), so settingsCatalogErrors(settings, fetch, options) is ready and tested but has no caller; step 4 of this card stays open, and the E19 and definition-of-done boxes stay unticked until then. Mass scouting selects its own scouting profile inside src/mass_scouting, so the chat guard is not applied there.

## Out of scope

Field table and defaults (PF-01), the `endpoint: systemone` rule (PF-07), catalog fetch (L0-08).
