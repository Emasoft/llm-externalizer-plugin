---
trdd-id: AQ82IO1T
title: IN-04 check (--preset) as an overlay flag
column: complete
status: archived
created: 2026-10-10T08:21:44+0200
updated: 2026-11-17T14:00:54+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:21:44+0200
implementation-commits: [6a4de637]
blocked-by: []
unblock-when: []
blocker-probe: grep -qE ^column:.complete$ design/tasks/TRDD-20261104_141115+0100-YGF9YXF2-full-npm-test-at-head-in-a-fresh-worktree-after-the-classify.md
blocker-holds-if: exit-nonzero
pre-block-column: 
---

# IN-04 check (--preset) as an overlay flag

## Goal

check takes `--preset` as an overlay flag, so `--preset invariant-check` or `--preset criterion-vs-tests` selects its union branch from the command line. An unknown preset value is refused by the union schema message.

## Plan refs

Plan 289, D15.

## Depends on

- IN-03 (TRDD-DCI7C2Y7), which provides the overlay mechanism.

## Acceptance

- [x] `--preset invariant-check --input f.json` and `--preset criterion-vs-tests` run
- [x] JSON that already has `preset` plus the flag: refused
- [x] no `--preset` and no `preset` in the JSON: schema refusal names the field
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:21:44+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T09:05:58+0200 — column → blocked. 6a4de637 landed; waits on the owner ruling about test doubles (plan card ZB41KG62)
- 2026-10-31T03:55:32+0100 — column → dev by main-agent@llm-externalizer-plugin. test-doubles ruling recorded on ZB41KG62 Cleared blocked-by (--clear-blocker override).
- 2026-11-04T10:09:08+0100 — column → blocked by main-agent@llm-externalizer-plugin. waits on TRDD-KNSQAQ1S (forbidden test doubles)
- 2026-11-04T13:31:50+0100 — column → testing by main-agent@llm-externalizer-plugin. test doubles clause met under R2 and R4; definition-of-done box waits on the clean-HEAD full suite run (headcheck) Cleared blocked-by (--clear-blocker override).
- 2026-11-04T13:57:44+0100 — column → blocked. Waits on the owner ruling in TRDD-M2H4RJVQ; the box also waits on a full suite at a HEAD that includes ddf17705 and a committed dist rebuilt from HEAD, which the host's memory pressure delays.
- 2026-11-05T01:43:57+0100 — column → testing by main-agent@llm-externalizer-plugin. TRDD-YGF9YXF2 complete: run 4b passed npm test; no blocker left Cleared blocked-by (all blockers terminal).
- 2026-11-17T14:00:54+0100 — COMPLETE by main-agent@llm-externalizer-plugin. definition of done met at HEAD 3d81775b; evidence in Notes.

## Notes

2026-10-10T09:05:56+0200 6a4de637: check takes --preset as a spec flag; an unknown value is refused by the union schema itself (no hand-written enum). Boxes proven by input-args.test.ts describe 'check --preset as an overlay flag (IN-04)' (9 tests, all passed by name in the commit gate). Structural change: spec flags moved from cli.flags to DecisionSpec.flags, because cli switches on file inputs; check has no cli and stays JSON-only (named test). Correction to 'Depends on': the overlay mechanism landed in IN-02 (a77c0f96), not IN-03; IN-03 (79b8b5fd) added SpecFlag.type. Added scope: find --top files-mode threshold test. The check replies are the real P-01 dec-choice2 reply re-keyed through the fetch seam (no recorded check reply exists). Definition-of-done box waits on the owner ruling about test doubles.
2026-11-04: definition of done not met: the card's tests use test doubles outside the 2026-10-31 ruling; the rework is TRDD-KNSQAQ1S.
2026-11-04T13:19:41+0100 KNSQAQ1S judgment: stays blocked. input-args.test.ts is fixed (3140eaaf) and classify-launch.test.ts is clean, but 6a4de637 also touched definitions-classify.test.ts, which still holds scripts/llm-ext/src/tools/definitions-classify.test.ts:22-25 (parserDeps: settings {} literal, throwing readFile and readStdin; reported by KNSQAQ1S as not fixed; created by 6cc2a9ad and 3c3db86f). Borderline: the verifier did not flag that line for this card and the commit did not write it; fixing it would unblock this card.
2026-11-04T13:31:48+0100 correction to the 13:19 judgment: under R2 (ZB41KG62 line 85) definitions-classify.test.ts:22-25 belongs to BUL4EEBP (blame, 6cc2a9ad) and does not block this card; extract.test.ts:536-537 is allowed under R4; index.test.ts spies are pre-existing and on their own card. The test-doubles clause is met on this card own test files under R2 and R4 (R4 pending owner ratification). Box (definition of done) waits on the clean-HEAD full suite, eslint . --quiet and build (reports_dev/headcheck/).
2026-11-04T13:43:27+0100 definition-of-done box also waits on a committed dist rebuilt from HEAD (stale committed dist; see TRDD-S5KOOT2S) and a full suite at a HEAD that includes ddf17705; the 23f40c1e headcheck does not cover it.
2026-11-04T14:12:14+0100 re-pointed (blame inventory 2026-11-04, R2): owns no R4-only site; the 13:57 line Waits on the owner ruling in TRDD-M2H4RJVQ is superseded for this card.
2026-11-04T14:14:25+0100 correction (coordinator): TRDD-6XMCY4ZE (committed dist) does not block this card; its definition-of-done box does not name a committed or built dist, and the full-suite build is done inside TRDD-YGF9YXF2. blocked-by and unblock-when carry no DIST id.
2026-11-05T01:44+0100 restored to testing: TRDD-YGF9YXF2 complete (run 4b at c668389e, npm test exit 0); no forbidden doubles in its own test files at HEAD; the definition-of-done box waits on eslint . --quiet and tsc at HEAD.
2026-11-05T01:55+0100 lint and typecheck measured on source identical to HEAD (scripts/ unchanged since c668389e; scratch worktree at c668389e, node_modules symlinked from the main tree, versions not rechecked against the lockfile since run 4b): tsc --noEmit -p scripts/llm-ext/tsconfig.json (src only) exit 0; npx eslint . --quiet run from scripts/llm-ext exit 0, 611 files, 0 errors, 0 warnings (reports_dev/ygf9yxf2/20261105_014302+0100-eslint-tsc-at-head.md, gitignored). This settles only the lint and typecheck part of the definition-of-done box; the box also needs the vitest include-list check, the WHY comments and the R1 reading of one commit with the TRDD id (the permissive reading, at least one commit names the id, is unratified in TRDD-M2H4RJVQ). No box ticked.
2026-11-05T01:55+0100 correction to the 01:43-01:44 move reason and note: no forbidden doubles means no vi.mock, vi.spyOn, vi.doMock or vi.stubGlobal call in its own test files at HEAD (grep); non-vi doubles were not judged in this pass.
2026-11-05T02:58+0100 WHY-comment pass (definition-of-done clause: WHY comments at non-obvious rules): a worker read the src diffs of the card commits and reported per-card verdicts with a spot-check (reports_dev/ygf9yxf2/20261105_021126+0100-why-review-findings.md, gitignored); the main agent re-read every gap it reported. Evidence limit: src diffs only, not tests, dist or the rest of each file. Commits 61efae4e and 948870d4 changed only comments in scripts/llm-ext/src/classifiers/run-decision.ts, so the 01:55 note's "scripts/ unchanged since c668389e" no longer holds literally. Checks at 948870d4 in a scratch worktree (node_modules symlinked from the main tree, lockfile not rechecked): tsc --noEmit -p scripts/llm-ext/tsconfig.json exit 0; eslint . from scripts/llm-ext 611 files including run-decision.ts, 0 errors, 0 warnings; run-decision.test.ts 65/65; the full suite was not rerun after c668389e (only comments changed since). No box ticked while rule R1 (TRDD-M2H4RJVQ) is unratified.
2026-11-05T02:58+0100 Verdict for this card (6a4de637): no non-obvious rule without a WHY found.
2026-11-05T03:06+0100 vitest include list (scripts/llm-ext/vitest.config.ts as committed at 73f863a3): every .test.ts file touched by 6a4de637 is listed: src/classifiers/input-args.test.ts (line 768), src/cli/classify-launch.test.ts (758), src/tools/definitions-classify.test.ts (756).
2026-11-17T14:00:51+0100 definition-of-done box, measured at HEAD 3d81775b (scripts/ identical to 04d412ea, git diff --stat empty): every .test.ts touched by the card commits is in scripts/llm-ext/vitest.config.ts and has no vi.mock, vi.spyOn, vi.doMock or vi.stubGlobal call (R4 seams converted by TRDD-S3QEQBYV, complete); npx eslint . --quiet from scripts/llm-ext exit 0; typecheck, lint and full npm test OK in the 14.6.1 publish run (publish-20261117_122713+0100.log lines 14, 16, 20), whose tree is 04d412ea; at least one implementation commit names this TRDD in its subject, so the R1 reading (body only) is not needed here; WHY verdict recorded 2026-11-05T02:58. Linux CI 44079104801 green on 04d412ea.
