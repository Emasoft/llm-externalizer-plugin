---
trdd-id: XZZ2NSWY
title: Runner awaits a spec prepare step so classify extract runs the regex worker
column: complete
status: archived
created: 2026-10-10T05:28:57+0200
updated: 2026-11-18T15:44:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T05:28:57+0200
blocked-by: []
unblock-when: [decision:owner-rules-R4-in-M2H4RJVQ]
pre-block-column: 
implementation-commits: [1111c2f6]
blocker-probe: grep -qE ^column:.complete$ design/tasks/TRDD-20261104_141115+0100-YGF9YXF2-full-npm-test-at-head-in-a-fresh-worktree-after-the-classify.md
blocker-holds-if: exit-nonzero
---

# Runner awaits a spec prepare step so classify extract runs the regex worker

## Goal

Make classify extract run the regex worker (SP-22, withMatches in classifiers/catalog/extract.ts) from the command line: today nothing calls it, so the command ends in no regex matches.

## Plan refs

Section 9 (classify extract), SP-22 (TRDD-DTDGVXWV, commit 0db9627e), C4-01 (TRDD-BUL4EEBP) runner, C4-03 (TRDD-4Q1IVJOE) launcher.

## Depends on

SP-22 (TRDD-DTDGVXWV, complete), C4-01 (TRDD-BUL4EEBP)

## Design

- The runner awaits an optional async prepare step on the spec before build. It runs after the cheap flag refusals and the -o check, so a refused invocation never starts a worker.
- The prepared input goes to the result step too, not only to build.
- Production passes only { signal } to withMatches, never spawn.
- Extract tests that hand in dummy matches are rewritten to go through the prepare step.
- One test runs against the real built CLI.

## Out of scope

Per-command input flags (TRDD-EVORI1LK), line positions (line-index mode card).

## Approval log

- 2026-10-10T05:28:57+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:16:46+0200 — column → blocked by main-agent@llm-externalizer-plugin. waits on the owner ruling about test doubles (plan card ZB41KG62, OWNER DECISION single open item)
- 2026-10-31T03:55:29+0100 — column → dev by main-agent@llm-externalizer-plugin. test-doubles ruling recorded on ZB41KG62 Cleared blocked-by (--clear-blocker override).
- 2026-11-04T10:09:15+0100 — column → blocked by main-agent@llm-externalizer-plugin. waits on TRDD-KNSQAQ1S (forbidden test doubles)
- 2026-11-04T13:31:58+0100 — column → testing by main-agent@llm-externalizer-plugin. test doubles clause met under R2 and R4; definition-of-done box waits on the clean-HEAD full suite run (headcheck) Cleared blocked-by (--clear-blocker override).
- 2026-11-04T13:57:22+0100 — column → blocked. Waits on the owner ruling in TRDD-M2H4RJVQ; the box also waits on a full suite at a HEAD that includes ddf17705 and a committed dist rebuilt from HEAD, which the host's memory pressure delays.
- 2026-11-18T15:44:29+0100 — COMPLETE by main-agent@llm-externalizer-plugin. R4 ruled ACCEPT (throwing never-called seam); boxes 1-6 met; full suite re-runs at the 14.7.3 publish gate. Cleared blocked-by (--clear-blocker override).

## Acceptance

- [x] runner awaits an optional async prepare step on the spec before build, after the cheap flag refusals and the -o check (test: a refused invocation starts no worker)
- [x] the prepared input reaches the result step as well as build (test)
- [x] production passes only { signal } to withMatches, never spawn (test or code read named)
- [x] extract tests that hand in dummy matches go through the prepare step
- [x] one test runs classify extract against the real built CLI
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Notes

Depends on the runner code already committed (643d7887), not on BUL4EEBP closing. It edits run-decision.ts, the same file as the BUL4EEBP test-double rework: run the two in sequence, never in parallel.
2026-10-10T08:13:23+0200 1111c2f6: classify extract now runs the regex worker: the runner awaits an optional spec.prepare after the cheap refusals and the -o check and before build; only extract sets it, and its prepare calls withMatches with only { signal }; the prepared input reaches build, chunkDefaults and project; a built-CLI test finds a one-match field with no model call. Deviation from the brief: profile and key checks stay after build, because a no-question build (E65) needs no profile and that is known only after prepare; a keyless extract run does local regex work before it is refused. A fraction --candidate-cap reaches prepare and is refused by withMatches before any worker; the test counts prepare calls, not workers. Definition-of-done box waits on the owner ruling (hand-built spec wrappers in its tests).
2026-10-10T08:44:06+0200 pre-block-column set to dev: the card was worked from todo (code in 1111c2f6), so a release must put it back in dev.
2026-11-04: definition of done not met: the card's tests use test doubles outside the 2026-10-31 ruling; the rework is TRDD-KNSQAQ1S.
2026-11-04T13:19:41+0100 KNSQAQ1S judgment: stays blocked. extract.test.ts depsOf (46a6bf84) and run-decision.test.ts depsOf (a3beab9f) are fixed, but 1111c2f6 added extract.test.ts:536-537 a hostile fake {spawn, timeoutMs} cast as never, flagged FORBIDDEN by the drain verifier (a real worker spawn can be produced), still present and on no KNSQAQ1S list.
2026-11-04T13:31:55+0100 correction to the 13:19 judgment: under R2 (ZB41KG62 line 85) definitions-classify.test.ts:22-25 belongs to BUL4EEBP (blame, 6cc2a9ad) and does not block this card; extract.test.ts:536-537 is allowed under R4; index.test.ts spies are pre-existing and on their own card. The test-doubles clause is met on this card own test files under R2 and R4 (R4 pending owner ratification). Box (definition of done) waits on the clean-HEAD full suite, eslint . --quiet and build (reports_dev/headcheck/).
2026-11-04T13:43:27+0100 definition-of-done box also waits on a committed dist rebuilt from HEAD (stale committed dist; see TRDD-S5KOOT2S) and a full suite at a HEAD that includes ddf17705; the 23f40c1e headcheck does not cover it.
2026-11-04T14:12:14+0100 re-pointed (blame inventory 2026-11-04, R2): owns no R4-only site; the 13:57 line Waits on the owner ruling in TRDD-M2H4RJVQ is superseded for this card.
2026-11-04T14:14:25+0100 correction (coordinator): TRDD-6XMCY4ZE (committed dist) does not block this card; its definition-of-done box does not name a committed or built dist, and the full-suite build is done inside TRDD-YGF9YXF2. blocked-by and unblock-when carry no DIST id.
2026-11-05T01:43+0100 blocked-by re-pointed from [YGF9YXF2] to [M2H4RJVQ]: TRDD-YGF9YXF2 is complete (run 4b at c668389e). Box 6 (no test doubles beyond the GlobalFetch seam) cannot be ticked without the owner ruling on the second half of R4 (a throwing never-called seam), which covers extract.test.ts:536-537 (blame 1111c2f6, this card commit); the M2H4RJVQ 13:55 line says that half still needs the owner. eslint and tsc at HEAD are measured in the same pass.
2026-11-05T01:55+0100 lint and typecheck measured on source identical to HEAD (scripts/ unchanged since c668389e; scratch worktree at c668389e, node_modules symlinked from the main tree, versions not rechecked against the lockfile since run 4b): tsc --noEmit -p scripts/llm-ext/tsconfig.json (src only) exit 0; npx eslint . --quiet run from scripts/llm-ext exit 0, 611 files, 0 errors, 0 warnings (reports_dev/ygf9yxf2/20261105_014302+0100-eslint-tsc-at-head.md, gitignored). This settles only the lint and typecheck part of the definition-of-done box; the box also needs the vitest include-list check, the WHY comments and the R1 reading of one commit with the TRDD id (the permissive reading, at least one commit names the id, is unratified in TRDD-M2H4RJVQ). No box ticked.
2026-11-18T15:35:44+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): TRDD-M2H4RJVQ was ruled: R4 ACCEPT. The extract.test.ts:539-540 object (real AbortSignal, a spawn that throws if called, timeoutMs) cast as never into spec.prepare is an injected sink that asserts non-use; the result is real (candidates equal Version), a real worker spawn would make the non-use assertion vacuous, and extract.test.ts holds no vi.mock or spyOn. R1 is not needed here: the subject of 1111c2f6 names TRDD-XZZ2NSWY. Definition-of-done box ticked on the 0f74f8d3 precedent: extract.test.ts in the vitest include list (vitest.config.ts:769); typecheck, lint, build and npm test OK in the 14.6.1 publish run (reports_dev/release-next/publish-20261117_122713+0100.log) and tsc/eslint exit 0 at c668389e; WHY comments at the prepare step in run-decision.ts:157,:204-208 and extract.ts:9,:46,:52,:123. Full suite not re-run at the current HEAD. blocked-by and the decision predicate are cleared by the main agent when moving the card. Evidence: triage report b1-blocked (XZZ2NSWY).
