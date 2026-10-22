---
trdd-id: B9FWID59
title: PT-03 acceptedProfileTypes on every command and the runtime check
column: complete
status: archived
created: 2026-10-07T19:30:01+0200
updated: 2026-10-10T00:55:49+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:01+0200
implementation-commits: [d71061de, 3e16f0a1, e8d7d255, 0421472e]
---

# PT-03 acceptedProfileTypes on every command and the runtime check

## Goal
Store the command × profile-type table once as `acceptedProfileTypes` in `tools/definitions.ts` and enforce it before any model call.

## Approval log

- 2026-10-07T19:30:01+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:55:38+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:55:44+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:55:49+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

§4 (single source for accepted types), §8 (command × type table), D37; E80, E81, E81i.

## Depends on

PT-01 (TRDD-QRF04JVJ), PT-02 (TRDD-IQTF34TC)

## Files

- `scripts/llm-ext/src/tools/definitions.ts` (`acceptedProfileTypes` per command)
- `scripts/llm-ext/src/cli/main.ts` (`--profile` handling, lines 584-603)
- tests and the vitest include entry: to be listed at card start

## Reuse

- `--profile` resolution, `cli/main.ts:584-603`
- evidence rows of the §8 table: `profile-fallback.ts:173`, `index.ts:5822-5836`, `config.ts:2934-2960`, `default-profiles.ts:327-331`, `mass_scouting/cli.ts:2086-2110`, `cli/launcher.ts:46-68`, `index.ts` ~5105 (`selectModels`), `default-profiles.ts:318-320`, `default-profiles.ts:321-325`, `benchmark/cli-args.ts:419-427`, `config.ts:1183-1188`
- the §8 table is the source; read the code at card start for anything else

## Steps

1. Verify the INFERRED rows of §8 in the code (`check *`, `session compact` local); update D37 and the table with the result (plan step 1).
2. Encode the §8 table once as `acceptedProfileTypes` on each command in `tools/definitions.ts`; `llm *`, `scan`, `scan impl`, `check *` accept local/free/paid; `scan quality` and `scan security` paid only; mass-scouting `scout` actions scouting only; `classify *` classifier only; `session compact` free/paid (local per step 1); `browse run` two profiles; no-model-call commands and `settings *` accept any type.
3. Check `--profile` and the active profile against the command's `acceptedProfileTypes` before any model call; a mismatch fails naming the command, the profile, its type and the accepted types.
4. Check that `active:` names only local, free or paid; otherwise a load error naming `active:` and the allowed types.
5. `--help` shows the accepted types.
6. Fallback walkers stay inside one type.
7. Add WHY comments at the check.

## Acceptance

- [x] step 1 verifies the INFERRED rows of §8 in the code and updates D37
- [x] the table encoded once in `tools/definitions.ts`
- [x] `--profile` and the active profile checked before any model call
- [x] `--help` shows the accepted types
- [x] walkers stay inside one type
- [x] E80: classifier or scouting profile given to `scan` → refused naming command, profile, type and accepted types
- [x] E81: local/free/paid/scouting profile given to `classify` → refused, same message
- [x] E81i: `active:` names a scouting or classifier profile → load error naming `active:` and the allowed types (local, free, paid)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed d71061de, 3e16f0a1 (its src/index.test.ts change rode in that commit because the file was shared), e8d7d255 (test include list), 0421472e (rebuilt dist) — src/profile-accept.ts (runtime check), src/tools/definitions.ts ACCEPTED_PROFILE_TYPES table and buildTools wrapper, src/cli/main.ts check before boot() with a settingsAsLoaded snapshot, profile-accept.test.ts (20 tests including real-CLI E80 and E81i, mutation-proven). build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. BEHAVIOUR CHANGES FOR THE USER TO VETO: (1) scan security is now paid-only per the plan table and previously ran on a local profile; (2) session compact refuses local (verified in code: it sends OpenRouter ':free' ids to the active backend), so D37 in the plan should read: session compact free/paid, local refused; (3) check rules and check plan make no model call and accept any type; (4) scout register/preclassify/estimate are scouting-only per the plan row though they make no model call. No CLI command writes active:; a wrong active: is fixed by hand. Note: --help accepted-types line is covered by code reading and the real-CLI tests, not by a dedicated help test. Plan file and D37 text not edited by the worker.

## Out of scope

Classifier rows of the table (PF-05), mass-scouting resolution (PT-05), the README table generated from this field (RD-20).
