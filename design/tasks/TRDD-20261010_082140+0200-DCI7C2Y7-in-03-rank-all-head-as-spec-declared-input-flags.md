---
trdd-id: DCI7C2Y7
title: IN-03 rank (--all, --head) as spec-declared input flags
column: testing
status: tasked
created: 2026-10-10T08:21:40+0200
updated: 2026-11-05T03:07:45+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:21:40+0200
implementation-commits: [79b8b5fd]
blocked-by: []
unblock-when: []
blocker-probe: grep -qE ^column:.complete$ design/tasks/TRDD-20261104_141115+0100-YGF9YXF2-full-npm-test-at-head-in-a-fresh-worktree-after-the-classify.md
blocker-holds-if: exit-nonzero
pre-block-column: 
---

# IN-03 rank (--all, --head) as spec-declared input flags

## Goal

rank gets `--all` and `--head N` as flags declared on its spec, so the full listing and the head-only send work from the command line and in JSON mode.

## Plan refs

Plan 283, 361, 399 (E34, E72), D27.

## Depends on

- IN-02 (TRDD-LMSYDGVB), which adds the SpecFlag mechanism.

## Acceptance

- [x] `--head N` sends only the first N bytes of a longer file and the whole shorter one
- [x] `--all` lists every candidate
- [x] `--head 1500 --keep-at 0.5` (D27 form) runs
- [x] flags valid in JSON mode too (overlay), refused if the JSON already holds the field
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:21:40+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:59:40+0200 — column → blocked. 79b8b5fd landed; waits on the owner ruling about test doubles (plan card ZB41KG62)
- 2026-10-31T03:55:31+0100 — column → dev by main-agent@llm-externalizer-plugin. test-doubles ruling recorded on ZB41KG62 Cleared blocked-by (--clear-blocker override).
- 2026-11-04T10:09:06+0100 — column → blocked by main-agent@llm-externalizer-plugin. waits on TRDD-KNSQAQ1S (forbidden test doubles)
- 2026-11-04T13:19:16+0100 — column → dev by main-agent@llm-externalizer-plugin. KNSQAQ1S fixed the test doubles this card depends on (3140eaaf input-args.test.ts); classify-launch.test.ts already clean Cleared blocked-by (--clear-blocker override).
- 2026-11-04T13:22:42+0100 — column → testing by main-agent@llm-externalizer-plugin. test doubles clause met (3140eaaf, classify-launch.test.ts clean under the (c) reading of readStdin stubs); box 5 waits on a full npm test and npx eslint . --quiet run after 3140eaaf
- 2026-11-04T13:57:38+0100 — column → blocked. Waits on the owner ruling in TRDD-M2H4RJVQ; the box also waits on a full suite at a HEAD that includes ddf17705 and a committed dist rebuilt from HEAD, which the host's memory pressure delays.
- 2026-11-05T01:43:56+0100 — column → testing by main-agent@llm-externalizer-plugin. TRDD-YGF9YXF2 complete: run 4b passed npm test; no blocker left Cleared blocked-by (all blockers terminal).

## Notes

2026-10-10T08:35:32+0200 Also owed here (from IN-01 XHHH0N1E): a named test that rank --keep-at and find --chunk/--min-score still parse as thresholds in files mode; then tick IN-01's threshold box.
2026-10-10T08:43:18+0200 Scope trimmed: the JSON-input overlay of spec flags landed in IN-02 (a77c0f96); this card keeps rank --all and --head as spec flags, plus the threshold-parse test owed from IN-01.
2026-10-10T08:59:38+0200 79b8b5fd: rank --head N and --all are spec flags (CLI and JSON overlay). Boxes proven by input-args.test.ts describe 'rank --head and --all as spec flags (IN-03)' (12 tests) plus classify-launch.test.ts (classifyArgv with --all; registry guard); all 14 passed by name in the commit gate. --head cuts at most N bytes at a character boundary. Mechanism change: SpecFlag.type (boolean|number); boolean flags take no value and parse is not called. Added scope: --head 0/-1/1.5/abc refusals, --all=x and repeated boolean refused, tool-schema types, registry guard, classifyArgv treats boolean spec flags as valueless (launcher.ts). The IN-02 dependency is met in code by a77c0f96; IN-02's blocked column is only the definition-of-done ruling. Definition-of-done box waits on the owner ruling about test doubles (the input-args harness injects readStdin, writers and settings).
2026-11-04: definition of done not met: the card's tests use test doubles outside the 2026-10-31 ruling; the rework is TRDD-KNSQAQ1S.
2026-11-04T13:19:16+0100 definition-of-done box ticked (TRDD-KNSQAQ1S judgment): input-args.test.ts now reads a real settings.yaml through loadSettings (3140eaaf); classify-launch.test.ts, its other test file, already did (441ce3fa) and has no vi.mock/vi.spyOn/vi.fn, no hand-built settings. Measured at HEAD on a tree carrying another session's uncommitted edits (cli/main.ts, config.ts, tools/definitions.ts, vitest.config.ts, dist): vitest over input-args, definitions-classify, run-decision, extract, findings, l0/catalog, l2/evidence and classify-launch test files 289/289 passed, tsc --noEmit exit 0, eslint on those 8 files --max-warnings 0 exit 0. Full npm test and eslint . --quiet were NOT re-run in this pass.
2026-11-04T13:22:40+0100 test doubles clause met (3140eaaf, classify-launch.test.ts clean under the (c) reading of readStdin stubs); box 5 waits on a full npm test and npx eslint . --quiet run after 3140eaaf. The 13:19 tick was withdrawn because the suite-wide clauses were not measured.
2026-11-04T13:43:27+0100 definition-of-done box also waits on a committed dist rebuilt from HEAD (stale committed dist; see TRDD-S5KOOT2S) and a full suite at a HEAD that includes ddf17705; the 23f40c1e headcheck does not cover it.
2026-11-04T13:43:27+0100 correction to the 13:19 note: "Measured at HEAD" was wrong; that 289/289 run used the main tree with another session uncommitted edits to cli/main.ts, config.ts and tools/definitions.ts, which drain rule R3 does not exempt.
2026-11-04T14:12:14+0100 re-pointed (blame inventory 2026-11-04, R2): owns no R4-only site; the 13:57 line Waits on the owner ruling in TRDD-M2H4RJVQ is superseded for this card.
2026-11-04T14:12:14+0100 reconciliation of the 13:22 (c) reading: under R2 the classify-launch.test.ts readStdin lines belong to 4Q1IVJOE (441ce3fa), so this card meets the test-doubles clause on R2 alone.
2026-11-04T14:14:25+0100 correction (coordinator): TRDD-6XMCY4ZE (committed dist) does not block this card; its definition-of-done box does not name a committed or built dist, and the full-suite build is done inside TRDD-YGF9YXF2. blocked-by and unblock-when carry no DIST id.
2026-11-05T01:44+0100 restored to testing: TRDD-YGF9YXF2 complete (run 4b at c668389e, npm test exit 0); no forbidden doubles in its own test files at HEAD; the definition-of-done box waits on eslint . --quiet and tsc at HEAD.
2026-11-05T01:55+0100 lint and typecheck measured on source identical to HEAD (scripts/ unchanged since c668389e; scratch worktree at c668389e, node_modules symlinked from the main tree, versions not rechecked against the lockfile since run 4b): tsc --noEmit -p scripts/llm-ext/tsconfig.json (src only) exit 0; npx eslint . --quiet run from scripts/llm-ext exit 0, 611 files, 0 errors, 0 warnings (reports_dev/ygf9yxf2/20261105_014302+0100-eslint-tsc-at-head.md, gitignored). This settles only the lint and typecheck part of the definition-of-done box; the box also needs the vitest include-list check, the WHY comments and the R1 reading of one commit with the TRDD id (the permissive reading, at least one commit names the id, is unratified in TRDD-M2H4RJVQ). No box ticked.
2026-11-05T01:55+0100 correction to the 01:43-01:44 move reason and note: no forbidden doubles means no vi.mock, vi.spyOn, vi.doMock or vi.stubGlobal call in its own test files at HEAD (grep); non-vi doubles were not judged in this pass.
2026-11-05T02:58+0100 WHY-comment pass (definition-of-done clause: WHY comments at non-obvious rules): a worker read the src diffs of the card commits and reported per-card verdicts with a spot-check (reports_dev/ygf9yxf2/20261105_021126+0100-why-review-findings.md, gitignored); the main agent re-read every gap it reported. Evidence limit: src diffs only, not tests, dist or the rest of each file. Commits 61efae4e and 948870d4 changed only comments in scripts/llm-ext/src/classifiers/run-decision.ts, so the 01:55 note's "scripts/ unchanged since c668389e" no longer holds literally. Checks at 948870d4 in a scratch worktree (node_modules symlinked from the main tree, lockfile not rechecked): tsc --noEmit -p scripts/llm-ext/tsconfig.json exit 0; eslint . from scripts/llm-ext 611 files including run-decision.ts, 0 errors, 0 warnings; run-decision.test.ts 65/65; the full suite was not rerun after c668389e (only comments changed since). No box ticked while rule R1 (TRDD-M2H4RJVQ) is unratified.
2026-11-05T02:58+0100 Verdict for this card (79b8b5fd): no missing WHY found; one comment-hygiene defect, not fixed: catalog/spec.ts:95 is a second JSDoc stacked above the JSDoc of parse(raw).
2026-11-05T03:06+0100 vitest include list (scripts/llm-ext/vitest.config.ts as committed at 73f863a3): every .test.ts file touched by 79b8b5fd is listed: src/classifiers/input-args.test.ts (line 768), src/cli/classify-launch.test.ts (758). The catalog/spec.ts:95 line number is at 948870d4; the defect moved to TRDD-HZMA4EXK.
