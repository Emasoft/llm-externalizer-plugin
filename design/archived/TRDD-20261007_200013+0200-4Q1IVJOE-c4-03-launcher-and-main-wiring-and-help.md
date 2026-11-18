---
trdd-id: 4Q1IVJOE
title: C4-03 Launcher and main wiring and help
column: complete
status: archived
created: 2026-10-07T20:00:13+0200
updated: 2026-11-18T15:44:28+0100
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
blocked-by: []
unblock-when: [decision:owner-rules-BL44BC32-scope-in-M2H4RJVQ, decision:owner-rules-R4-in-M2H4RJVQ]
pre-block-column: 
blocker-probe: grep -qE ^column:.complete$ design/archived/TRDD-20261104_141125+0100-S3QEQBYV-classify-tests-read-stdin-from-a-real-stream-so-r4-is-unnece.md
blocker-holds-if: exit-nonzero
---

# C4-03 Launcher and main wiring and help

## Goal

Wire the classify group into the launcher and main entry with nested help and typo suggestion.

## Approval log

- 2026-10-07T20:00:13+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T05:00:41+0200 — column → dev by main-agent@llm-externalizer-plugin. C4-03 dispatched to a worker: C4-02 entries (6cc2a9ad, 3c3db86f) and PF-05 rows (3c3db86f) are committed
- 2026-10-10T08:16:46+0200 — column → blocked by main-agent@llm-externalizer-plugin. waits on the owner ruling about test doubles (plan card ZB41KG62, OWNER DECISION single open item)
- 2026-10-31T03:55:28+0100 — column → dev by main-agent@llm-externalizer-plugin. test-doubles ruling recorded on ZB41KG62 Cleared blocked-by (--clear-blocker override).
- 2026-11-04T10:09:11+0100 — column → blocked by main-agent@llm-externalizer-plugin. waits on TRDD-KNSQAQ1S (forbidden test doubles)
- 2026-11-04T13:32:02+0100 — column → testing by main-agent@llm-externalizer-plugin. test doubles clause met under R2 and R4; definition-of-done box waits on the clean-HEAD full suite run (headcheck) Cleared blocked-by (--clear-blocker override).
- 2026-11-04T13:57:17+0100 — column → blocked. Waits on the owner ruling in TRDD-M2H4RJVQ; the box also waits on a full suite at a HEAD that includes ddf17705 and a committed dist rebuilt from HEAD, which the host's memory pressure delays.
- 2026-11-18T15:44:28+0100 — COMPLETE by main-agent@llm-externalizer-plugin. M2H4RJVQ ruled; DoD evidenced (subjects name the card, include list, no doubles, 14.6.1 publish run full suite); full suite re-runs at the 14.7.3 publish gate. Cleared blocked-by (--clear-blocker override).

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
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

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
2026-11-04: definition of done not met: the card's tests use test doubles outside the 2026-10-31 ruling; the rework is TRDD-KNSQAQ1S.
2026-11-04T13:19:41+0100 KNSQAQ1S judgment: stays blocked. Fixed: definitions-classify.test.ts:153 (aaf521c2), run-decision.test.ts (a3beab9f), extract.test.ts depsOf (46a6bf84). Still open: (1) scripts/llm-ext/src/tools/definitions-classify.test.ts:22-25 (parserDeps: settings {} literal, throwing readFile and readStdin; reported by KNSQAQ1S as not fixed; created by 6cc2a9ad and 3c3db86f), a file 5f282fff and 1c08c7ff touched; (2) extract.test.ts:536-537 hostile fake {spawn, timeoutMs} cast as never, added by 1111c2f6 (this card shares it with XZZ2NSWY), flagged FORBIDDEN by the drain verifier and on no KNSQAQ1S list; (3) index.test.ts:1105 spyOn dynamicProfileGate and :1866, :2119 spyOn globalThis.fetch, pre-existing and listed under this card's files by the verifier as forbidden if in scope, on no KNSQAQ1S list. A user decision is needed on (3).
2026-11-04T13:32:00+0100 correction to the 13:19 judgment: under R2 (ZB41KG62 line 85) definitions-classify.test.ts:22-25 belongs to BUL4EEBP (blame, 6cc2a9ad) and does not block this card; extract.test.ts:536-537 is allowed under R4; index.test.ts spies are pre-existing and on their own card. The test-doubles clause is met on this card own test files under R2 and R4 (R4 pending owner ratification). Box (definition of done) waits on the clean-HEAD full suite, eslint . --quiet and build (reports_dev/headcheck/).
2026-11-04T13:36:23+0100 if the owner rules the index.test.ts spies (TRDD-BL44BC32) in scope for this card, it returns to blocked; until then its own files meet the test-doubles clause under R2 and R4.
2026-11-04T13:39:36+0100 the owner decision on scope is TRDD-7X2BGHLH.
2026-11-04T13:41:31+0100 the owner decision card is now TRDD-M2H4RJVQ (7X2BGHLH superseded).
2026-11-04T13:43:27+0100 definition-of-done box also waits on a committed dist rebuilt from HEAD (stale committed dist; see TRDD-S5KOOT2S) and a full suite at a HEAD that includes ddf17705; the 23f40c1e headcheck does not cover it.
2026-11-04T13:49:32+0100 classify-launch-cli.test.ts (5 tests) and classify-review-cli.test.ts (7 tests) failed in the 23f40c1e headcheck against the stale committed dist and passed on a fresh build (rerun 64/64); card ownership of these files is inferred from their names.
2026-11-04T14:12:14+0100 re-pointed (blame inventory 2026-11-04, R2): owns site A2; the 13:57 line Waits on the owner ruling in TRDD-M2H4RJVQ is superseded for this card, except the BL44BC32 scope.
2026-11-04T14:14:25+0100 correction (coordinator): TRDD-6XMCY4ZE (committed dist) does not block this card; its definition-of-done box does not name a committed or built dist, and the full-suite build is done inside TRDD-YGF9YXF2. blocked-by and unblock-when carry no DIST id.
2026-11-04T14:27:17+0100 once the owner answers the BL44BC32 scope question, the agent removes M2H4RJVQ from 4Q1IVJOE's blocked-by together with its decision predicate: drift releases a blocked-by id only when that card reaches a done column, and this proposal may never reach one.
2026-11-05T01:43+0100 blocked-by re-pointed from [YGF9YXF2, M2H4RJVQ] to [M2H4RJVQ]: TRDD-YGF9YXF2 is complete (run 4b at c668389e, npm test exit 0); the card still waits on the owner ruling in TRDD-M2H4RJVQ on whether the index.test.ts spies of TRDD-BL44BC32 (:1105, :1866, :2119) and extract.test.ts:536-537 (R4) count against it, as its own 13:36:23 note says.
2026-11-05T01:55+0100 lint and typecheck measured on source identical to HEAD (scripts/ unchanged since c668389e; scratch worktree at c668389e, node_modules symlinked from the main tree, versions not rechecked against the lockfile since run 4b): tsc --noEmit -p scripts/llm-ext/tsconfig.json (src only) exit 0; npx eslint . --quiet run from scripts/llm-ext exit 0, 611 files, 0 errors, 0 warnings (reports_dev/ygf9yxf2/20261105_014302+0100-eslint-tsc-at-head.md, gitignored). This settles only the lint and typecheck part of the definition-of-done box; the box also needs the vitest include-list check, the WHY comments and the R1 reading of one commit with the TRDD id (the permissive reading, at least one commit names the id, is unratified in TRDD-M2H4RJVQ). No box ticked.
2026-11-05T01:55+0100 correction to the 01:43 note: the basis for the M2H4RJVQ block is this card lines :96 (the BL44BC32-scope wait stays on this card) and :98 (M2H4RJVQ is removed after the owner answers) and the pre-existing M2H4RJVQ blocker; the 13:36:23 note (:91) is conditional and does not mention extract.test.ts:536-537. Those lines come from 1111c2f6, which this card and XZZ2NSWY both list, so the R4 ruling applies here too.
2026-11-05T04:12+0100 blocker-probe re-pointed to design/archived/: TRDD-S3QEQBYV is complete and was moved there, so the old design/tasks path failed grep and reported a blocker that no longer held. This card stays blocked on TRDD-M2H4RJVQ (blocked-by and two decision predicates).
2026-11-18T15:35:31+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): TRDD-M2H4RJVQ was ruled: R1 ACCEPT, R4 ACCEPT (both halves; the extract.test.ts:539-540 throwing never-called seam is an injected sink asserting non-use), BL44BC32 scope OUT for this card (git show of 5f282fff 1c08c7ff 441ce3fa 1111c2f6 on index.test.ts adds no spyOn; the index.test.ts spies blame 4bdd9b1b, 14.1.0). Definition-of-done box ticked on the 0f74f8d3 precedent: tests in the vitest include list (vitest.config.ts:830-832 classify-launch.test.ts, classify-launch-cli.test.ts); typecheck, lint, build and npm test OK in the 14.6.1 publish run (reports_dev/release-next/publish-20261117_122713+0100.log, tree 04d412ea) and tsc/eslint exit 0 at c668389e; no test doubles in its own files after 441ce3fa, aaf521c2 and S3QEQBYV; commit subjects 5f282fff, 1c08c7ff, 441ce3fa, 1111c2f6 name TRDD-4Q1IVJOE; WHY comments present in cli/launcher.ts and cli/main.ts. Full suite not re-run at the current HEAD. blocked-by and the two decision predicates are cleared by the main agent when moving the card. Evidence: triage report b1-blocked (4Q1IVJOE).
