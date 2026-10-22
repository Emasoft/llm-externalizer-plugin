---
trdd-id: RPEKSYJL
title: PT-05 Mass scouting accepts only the scouting type
column: complete
status: archived
created: 2026-10-07T19:30:21+0200
updated: 2026-10-10T03:14:22+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:21+0200
implementation-commits: [21875b8b, f651b119, da2da099]
---

# PT-05 Mass scouting accepts only the scouting type

## Goal
Make every mass-scouting model action resolve its model from a `scouting`-type profile, ending mass scouting on the free pool (D34).

## Approval log

- 2026-10-07T19:30:21+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T03:13:13+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:13:18+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed
- 2026-10-10T03:14:22+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-8 work committed.

## Plan refs

§8, D34; E81b.

## Depends on

PT-03 (TRDD-B9FWID59), PT-04 (TRDD-N2L9BN1Q)

## Files

- `scripts/llm-ext/src/mass_scouting/cli.ts` (`:549-561, :605-606`)
- `scripts/llm-ext/src/default-profiles.ts` (`:327-349`)
- tests and the vitest include entry: to be listed at card start

## Reuse

- `scout-accuracy.ts:143-150` (scouting model may not be a `:free` id)
- the PT-03 type check
- read the code at card start for `activeProfileFreeOnly`

## Steps

1. Remove the `activeProfileFreeOnly` delegation (`mass_scouting/cli.ts:549-561, 605-606`).
2. Make `run`, `chain`, `propose-fieldset`, `estimate`, `register` and `preclassify` resolve their model from the `scouting`-type profile; `--profile` may name another scouting-type profile.
3. Replace the free-mode refusals for these actions (`default-profiles.ts:327-349`) with the type check.
4. `scout` actions that call no model stay unaffected.
5. Add WHY comments (mass scouting on free models ends, D34).

## Acceptance

- [x] `activeProfileFreeOnly` delegation removed (`mass_scouting/cli.ts:549-561, 605-606`)
- [x] `run`, `chain`, `propose-fieldset`, `estimate`, `register`, `preclassify` resolve their model from the `scouting`-type profile (`--profile` may name another scouting-type profile)
- [x] free-mode refusals for these actions (`default-profiles.ts:327-349`) replaced by the type check
- [x] E81b: free profile active and `scout run` called → uses the `scouting` profile; if it is the placeholder, refuses with "run `llm-ext benchmark scout-accuracy`"
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 21875b8b (scouting-type resolution, spend gate, --profile forwarding, tests), f651b119 (test include list for scouting-profile-forwarding.test.ts), da2da099 (rebuilt dist) — mass_scouting/cli.ts: activeProfileFreeOnly deleted; scout, chain, propose-fieldset, estimate and register resolve the model of the scouting profile (--profile may name another scouting-type profile, a nonexistent one lists the available ones, a non-scouting type is refused); preclassify makes no model call so only PT-03's type check applies; default-profiles.ts free-mode refusals for mass_scout, chain and propose-fieldset removed (only security_scan and high_quality_scan remain); E81b pinned (placeholder scouting profile refuses with run llm-ext benchmark scout-accuracy). The spend gate reads allow_paid_models from settings.yaml (absent or unreadable means refused) and refuses early with no request; a run that bills while the active profile never bills prints one line; register and estimate still work without a populated scouting profile (estimate says it priced a stand-in model). Follow-up: cli/main.ts forwards --profile as tool arg for scouting-only commands (the active text profile is untouched) and index.ts isScoutingOnlyTool skips the dynamic active-profile gate and the free-pool override for them (new cli/scouting-profile-forwarding.test.ts, 9 tests). build then full suite on the committed tree: 249 files / 4051 passed / 0 failed, tsc and eslint clean, no temp-dir leak. OPEN ITEMS: README.md around line 1101 still describes the old free-mode refusal (docs cards); benchmark/free-fitness-ledger.ts still has FitnessTool mass_scout and the mass-scout-throughput benchmark, now unreachable for the free gate (clean-up card); cli/main.ts PROFILE_AWARE_TOOLS still lists the mass_scout tools (harmless).

## Out of scope

The table and generic runtime check (PT-03), the scouting template and placeholder refusal text (PT-04).
