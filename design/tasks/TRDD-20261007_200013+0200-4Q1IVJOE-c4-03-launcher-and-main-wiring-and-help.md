---
trdd-id: 4Q1IVJOE
title: C4-03 Launcher and main wiring and help
column: blocked
status: tasked
created: 2026-10-07T20:00:13+0200
updated: 2026-10-10T08:29:45+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:13+0200
implementation-commits: [5f282fff, 1c08c7ff, 441ce3fa, 1111c2f6]
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
pre-block-column: dev
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
---

# C4-03 Launcher and main wiring and help

## Goal

Wire the classify group into the launcher and main entry with nested help and typo suggestion.

## Approval log

- 2026-10-07T20:00:13+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T05:00:41+0200 — column → dev by main-agent@llm-externalizer-plugin. C4-03 dispatched to a worker: C4-02 entries (6cc2a9ad, 3c3db86f) and PF-05 rows (3c3db86f) are committed
- 2026-10-10T08:16:46+0200 — column → blocked by main-agent@llm-externalizer-plugin. waits on the owner ruling about test doubles (plan card ZB41KG62, OWNER DECISION single open item)

## Plan refs

§3 L4 row (`index.ts`, `cli/launcher.ts`, `cli/main.ts`), §16 verification rule (bare command name).

## Depends on

C4-02 (TRDD-V8Q20MLW)

## Files

- `scripts/llm-ext/src/index.ts`, `scripts/llm-ext/src/cli/launcher.ts`, `scripts/llm-ext/src/cli/main.ts` (change).
- Test file and vitest include entry: to be listed at card start.

## Reuse

Read the code at card start (existing nested help and typo-suggestion behaviour of `llm-ext <group> --help`).

## Steps

1. Read `cli/main.ts` and `cli/launcher.ts`; note how existing groups register help and typo suggestions (derived from done-when).
2. Register the classify group so `llm-ext classify --help` and `llm-ext classify <action> --help` nest (derived from done-when).
3. Typo in an action name suggests the right verb and exits non-zero (derived from done-when).
4. Verify with the bare command: `llm-ext classify … --help`, not a repo-relative `node ./dist/cli.js`.

## Acceptance

- [x] nested help
- [x] typo suggestion
- [x] verified via bare `llm-ext classify … --help`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Entry definitions (C4-02), help text content (C4-11), top-level usage skill update (DOC-16).

## Notes

2026-10-10: commit 5f282fff. Box 1 (nested help) proven by src/cli/classify-launch-cli.test.ts ('classify --help lists every action and creates no settings file', 'classify filter --help shows the thresholds with default and range'); box 2 (typo) by classify-launch.test.ts and classify-launch-cli.test.ts ('a typo suggests the right verb and exits 1'); box 3 by the coordinator's bare-command check through a temporary PATH shim: help exit 0 listing 14 actions, action help exit 0, typo exit 1 with 'did you mean', config dir empty after help. Box 4 (definition of done) NOT ticked: the follow-up commit below is not made. Verified together with 0db9627e (TRDD-DTDGVXWV) on one green run: build, tsc, eslint, 265 test files / 4756 tests, tree unchanged, real settings hash unchanged.
CORRECTION to the commit message of 5f282fff: the sentence 'the ONE existing profile-type refusal applies' is WRONG. For classify, main.ts skips the general profile-type check; the runner's own check (selectClassifierProfile in classifiers/l2/profile.ts) refuses a text profile. PF-05's generated classifier-only rows are the declared/help surface, not the enforcement. The test tying the two together landed in 1c08c7ff (definitions-classify.test.ts).
2026-10-10T07:52:17+0200 FIXED in 1c08c7ff: a leading global boolean flag no longer makes a classify command load the engine. A leading --quiet before classify is still refused (exit 1, unknown command '--quiet'), as it was before; the fix makes that refusal create no settings. It does not make help work in that form.
C4-02 review follow-ups (the last three small points) were applied in 5f282fff, verified with git show on tools/definitions.ts: the generated classifier rows are spread last, ACCEPTED_PROFILE_TYPES is wrapped in Object.freeze, and the stale 'parseFlags accepts both' comment now points to launcher.ts classifyArgv.
2026-10-10T07:52:17+0200 The worker's report mentions 3 of 4789 tests failing on the empty-directory assertion. That failure is consistent with a run of the new leading-flag tests against the stale committed bundle (the fix had been built only under /tmp); the failing run was not reproduced. After the rebuild the full suite passes (4766).
2026-10-10T07:52:17+0200 Definition-of-done box NOT ticked; the card stays in dev. Unmet clause: 'no test doubles beyond the GlobalFetch seam'. scripts/llm-ext/src/cli/classify-launch.test.ts:24-27 injects a fake spec (fake-fifteenth) into the classifyActions registry; :115-124 the io() helper injects a hand-built settings object, a throwing readFile stub and a stubbed readStdin.
2026-10-10T08:01:21+0200 441ce3fa: classify-launch.test.ts uses the real 14-spec registry, a real settings.yaml read by loadSettings (asserted byte-identical, no backups/), real --input files; readStdin throws (stdin covered by classify-launch-cli.test.ts). Correction to that commit's message 'the only double left is the GlobalFetch seam': the tests still inject a sigint EventEmitter and stdout/stderr writers collecting into arrays (existing seams). Definition-of-done box stays unticked pending the owner ruling on the plan card.
2026-10-10T08:13:23+0200 1111c2f6 carries the C4-03 part: the --quiet scan / --quiet session built-CLI cases now assert exit 1 and 'unknown command --quiet' and say they pin a refused line that still creates settings.
2026-10-10T08:13:23+0200 The note naming classify-launch.test.ts:24-27 and :115-124 is superseded by the 08:01:21 note (441ce3fa removed those doubles).
