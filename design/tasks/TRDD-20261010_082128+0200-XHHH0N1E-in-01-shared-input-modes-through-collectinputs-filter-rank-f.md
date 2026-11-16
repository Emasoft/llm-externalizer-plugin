---
trdd-id: XHHH0N1E
title: IN-01 Shared input modes through collectInputs (filter, rank, find)
column: testing
status: tasked
created: 2026-10-10T08:21:28+0200
updated: 2026-11-16T09:24:50+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:21:28+0200
blocked-by: []
unblock-when: [trdd:G0MS9B63]
blocker-probe: 'grep -rqE ''^column: (complete|completed|cancelled)$'' design --include=\*G0MS9B63\*'
blocker-holds-if: exit-nonzero
pre-block-column: 
implementation-commits: [b159d89b, 61efae4e, 948870d4]
---

# IN-01 Shared input modes through collectInputs (filter, rank, find)

## Goal

`llm-ext classify filter "<question>" <inputs>`, `classify rank "<query>" <inputs>`, `classify find "<query>" <files>` accept files, directories, globs, `-`, `--items`, `--lines`, `--ext`, `--limit`, `--max-bytes`, `--follow-symlinks`, and run end to end; specs without `cli` refuse file mode for now ('does not take file inputs yet'); later cards add their mappings.

## Plan refs

Plan lines: 273, 168, 170, 278-284 (filter/rank/find rows), 360-368, 452-460; E33, E35, E36, E40, E41, E119-E127; qs:728-805, 914-919, 960-962, 1054-1057, 1073-1081.

## Depends on

None. First card of the set; dispatchable as is.

## Acceptance

- [x] filter over a directory in a temp git repo sends one text unit per tracked/untracked non-ignored file; ids are relative paths (E119); outside git, build dirs and dot-directories are skipped (E120)
- [x] `--lines` over a log gives ids `name:N`; `-` reads stdin as one item `stdin`; `--items f.jsonl` and `--items -` follow E127
- [x] glob input works; on Node<22 it is refused with "pass a directory instead" (E121, via the existing `nodeMajor` option)
- [x] a secret file found while walking is skipped and printed as `skipped <path>: <reason>` warning; a named secret/binary/empty/directory given to `--items` is refused, exit 1 (E33, E36, E40, E41, E124)
- [x] `--ext`, `--limit` (E126), `--max-bytes` (E125), `--follow-symlinks` (E122) reach `collectInputs`; an invalid value exits 1 naming the flag
- [x] no inputs at all, or all skipped: exit 1 with qs's "nothing to <cmd>" wording (qs:914-919)
- [x] a spec without a cli mapping refuses file-mode tokens with "does not take file inputs yet", exit 1
- [x] rank and find run with `mode: "files"`; rank `--top`/`--keep-at`, find `--chunk`/`--min-score`/`--top` still parse as thresholds
- [x] plain JSON mode (`--input`, stdin) behaves exactly as before (existing tests green after the Buffer change)
- [x] `classifyArgv` does not treat the token after `--lines` / `--follow-symlinks` as a value; `definitions.ts` advertises the input flags for filter/rank/find only
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:21:28+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:23:56+0200 — column → dev by main-agent@llm-externalizer-plugin. dispatched 2026-10-10
- 2026-10-10T08:34:35+0200 — column → blocked by main-agent@llm-externalizer-plugin. waits on the owner ruling about test doubles (plan card ZB41KG62)
- 2026-10-31T03:55:30+0100 — column → dev by main-agent@llm-externalizer-plugin. test-doubles ruling recorded on ZB41KG62 Cleared blocked-by (--clear-blocker override).
- 2026-11-04T10:09:10+0100 — column → blocked by main-agent@llm-externalizer-plugin. waits on TRDD-KNSQAQ1S (forbidden test doubles)
- 2026-11-04T13:31:54+0100 — column → testing by main-agent@llm-externalizer-plugin. test doubles clause met under R2 and R4; definition-of-done box waits on the clean-HEAD full suite run (headcheck) Cleared blocked-by (--clear-blocker override).
- 2026-11-04T13:57:27+0100 — column → blocked. Waits on the owner ruling in TRDD-M2H4RJVQ; the box also waits on a full suite at a HEAD that includes ddf17705 and a committed dist rebuilt from HEAD, which the host's memory pressure delays.
- 2026-11-05T01:43:55+0100 — column → testing by main-agent@llm-externalizer-plugin. TRDD-YGF9YXF2 complete: run 4b passed npm test; no blocker left Cleared blocked-by (all blockers terminal).
- 2026-11-14T18:50:58+0100 — column → blocked by main-agent@llm-externalizer-plugin. only the full npm test remains, and it cannot pass until the better-sqlite3 binding is rebuilt (TRDD-G0MS9B63, user action)
- 2026-11-16T09:24:50+0100 — column → testing by main-agent@llm-externalizer-plugin. blocker G0MS9B63 complete Cleared blocked-by (--clear-blocker override).

## Notes

2026-10-10T08:32:32+0200 b159d89b: IN-01 classify filter, rank and find take files, directories, globs, -, --items, --lines, --ext, --limit, --max-bytes and --follow-symlinks through collectInputs, and the 23 input-args tests pass. Deviation from qs.mjs:64-77: a leading single-dash word is refused (did you mean --x? when such a flag exists) so a typo cannot become a paid question. Definition-of-done box waits on the owner ruling about test doubles (category c).
2026-10-10T08:34:52+0200 Boxes 'rank and find ... still parse as thresholds' and 'classifyArgv ... definitions.ts advertises ...' stay unticked: only rank --top and the classifyArgv booleans are proven by named tests; --keep-at, --chunk, --min-score and the definitions part need a named test each (small follow-up).
2026-10-10T08:35:32+0200 Correction to the previous note: the classifyArgv/definitions box is proven by input-args.test.ts:329 (--lines and --follow-symlinks take no value) and definitions-classify.test.ts 'an entry carries exactly the spec's thresholds plus the shared flags' (INPUT_FLAGS only for specs with cli); ticked. The threshold box (rank --keep-at, find --chunk/--min-score in files mode) gets its named test in IN-03 (DCI7C2Y7).
2026-10-10T08:59:38+0200 Threshold box: rank --keep-at, rank --top, find --chunk and --min-score now have named files-mode tests (79b8b5fd, input-args.test.ts IN-03 describe); find --top in files mode still has no named test, so the box stays unticked.
2026-10-10T09:05:56+0200 Threshold box ticked: find --top now has a named files-mode test (6a4de637, 'find --top 2 still parses as a threshold in files mode'), joining rank --keep-at/--top and find --chunk/--min-score (79b8b5fd) and the mode files assertions (input-args.test.ts:158,160). The find --top test proves the value is not taken as an input path; it does not assert the top-2 limit's effect.
2026-11-04: definition of done not met: the card's tests use test doubles outside the 2026-10-31 ruling; the rework is TRDD-KNSQAQ1S.
2026-11-04T13:19:41+0100 KNSQAQ1S judgment: stays blocked. input-args.test.ts (3140eaaf), run-decision.test.ts (a3beab9f) and definitions-classify.test.ts:153 (aaf521c2) are fixed, but definitions-classify.test.ts, which the box note cites as proof, still holds scripts/llm-ext/src/tools/definitions-classify.test.ts:22-25 (parserDeps: settings {} literal, throwing readFile and readStdin; reported by KNSQAQ1S as not fixed; created by 6cc2a9ad and 3c3db86f). Borderline: the verifier did not flag that line for this card and b159d89b did not write it; fixing it would unblock this card.
2026-11-04T13:31:52+0100 correction to the 13:19 judgment: under R2 (ZB41KG62 line 85) definitions-classify.test.ts:22-25 belongs to BUL4EEBP (blame, 6cc2a9ad) and does not block this card; extract.test.ts:536-537 is allowed under R4; index.test.ts spies are pre-existing and on their own card. The test-doubles clause is met on this card own test files under R2 and R4 (R4 pending owner ratification). Box (definition of done) waits on the clean-HEAD full suite, eslint . --quiet and build (reports_dev/headcheck/).
2026-11-04T13:43:27+0100 definition-of-done box also waits on a committed dist rebuilt from HEAD (stale committed dist; see TRDD-S5KOOT2S) and a full suite at a HEAD that includes ddf17705; the 23f40c1e headcheck does not cover it.
2026-11-04T14:12:14+0100 re-pointed (blame inventory 2026-11-04, R2): owns sites A4, A6, A10, A11; the 13:57 line Waits on the owner ruling in TRDD-M2H4RJVQ is superseded for this card.
2026-11-04T14:14:25+0100 correction (coordinator): TRDD-6XMCY4ZE (committed dist) does not block this card; its definition-of-done box does not name a committed or built dist, and the full-suite build is done inside TRDD-YGF9YXF2. blocked-by and unblock-when carry no DIST id.
2026-11-05T01:44+0100 restored to testing: TRDD-YGF9YXF2 complete (run 4b at c668389e, npm test exit 0); no forbidden doubles in its own test files at HEAD; the definition-of-done box waits on eslint . --quiet and tsc at HEAD.
2026-11-05T01:55+0100 lint and typecheck measured on source identical to HEAD (scripts/ unchanged since c668389e; scratch worktree at c668389e, node_modules symlinked from the main tree, versions not rechecked against the lockfile since run 4b): tsc --noEmit -p scripts/llm-ext/tsconfig.json (src only) exit 0; npx eslint . --quiet run from scripts/llm-ext exit 0, 611 files, 0 errors, 0 warnings (reports_dev/ygf9yxf2/20261105_014302+0100-eslint-tsc-at-head.md, gitignored). This settles only the lint and typecheck part of the definition-of-done box; the box also needs the vitest include-list check, the WHY comments and the R1 reading of one commit with the TRDD id (the permissive reading, at least one commit names the id, is unratified in TRDD-M2H4RJVQ). No box ticked.
2026-11-05T01:55+0100 correction to the 01:43-01:44 move reason and note: no forbidden doubles means no vi.mock, vi.spyOn, vi.doMock or vi.stubGlobal call in its own test files at HEAD (grep); non-vi doubles were not judged in this pass.
2026-11-05T02:58+0100 WHY-comment pass (definition-of-done clause: WHY comments at non-obvious rules): a worker read the src diffs of the card commits and reported per-card verdicts with a spot-check (reports_dev/ygf9yxf2/20261105_021126+0100-why-review-findings.md, gitignored); the main agent re-read every gap it reported. Evidence limit: src diffs only, not tests, dist or the rest of each file. Commits 61efae4e and 948870d4 changed only comments in scripts/llm-ext/src/classifiers/run-decision.ts, so the 01:55 note's "scripts/ unchanged since c668389e" no longer holds literally. Checks at 948870d4 in a scratch worktree (node_modules symlinked from the main tree, lockfile not rechecked): tsc --noEmit -p scripts/llm-ext/tsconfig.json exit 0; eslint . from scripts/llm-ext 611 files including run-decision.ts, 0 errors, 0 warnings; run-decision.test.ts 65/65; the full suite was not rerun after c668389e (only comments changed since). No box ticked while rule R1 (TRDD-M2H4RJVQ) is unratified.
2026-11-05T02:58+0100 Verdict for this card (b159d89b): the -o exemption in the single-dash refusal had no WHY; 61efae4e added one and 948870d4 corrected it (run-decision.ts:468). Open: the 400-character clip at input-args.ts:135 has no stated reason in the code or in b159d89b; the worker rated it a non-obvious literal, the main agent judged it covered by the qs-port comment above it; not settled (it may be a qs constant, not verified). Comment-hygiene defect, not fixed: classifiers/shared-flags.ts:39 and :50 carry two "Help sentences checked against l2/inputs.ts" comments that cite different line numbers. Left by the second review of 948870d4 for the next code change of run-decision.ts (review round limit reached): the -o sync rule should also name INPUT_FLAGS, the spec flags and launcher.ts classifyArgv; a test that refuses -x and accepts -o would enforce it (whether one exists was not checked).
2026-11-05T03:06+0100 Correction to the 02:58 line: the 400-character clip is settled. It is the quicksilver constant ported verbatim: qs.mjs:916 builds the same message, skipped (clip(skipped.join(', '), 400)), and the comment "qs requireInputs wording" above input-args.ts:135 names that source; quicksilver gives no reason for 400 either, so no further WHY can be sourced and the main agent judges the clause met for it. Line numbers in these notes are at 948870d4. Deferred comment wording (run-decision.ts:468) and the shared-flags.ts:39/:50 duplicate moved to TRDD-HZMA4EXK.
2026-11-05T03:06+0100 vitest include list (scripts/llm-ext/vitest.config.ts as committed at 73f863a3): every .test.ts file touched by b159d89b is listed: src/classifiers/input-args.test.ts (line 768), src/classifiers/run-decision.test.ts (736), src/tools/definitions-classify.test.ts (756).
2026-11-05T03:15+0100 Checked: the comments around qs.mjs:891 and :916 give no reason for 400. Whether a port from a named source counts as a WHY is an owner question on TRDD-AFX6CR8K; until it is answered, "the clause met for it" in the 03:06 line is the main agent's judgement only.
2026-11-05T03:26+0100 implementation-commits now also lists 61efae4e and 948870d4, which added and corrected the WHY of the -o exemption in the single-dash refusal.
2026-11-05T04:12+0100 blocker-probe re-pointed to design/archived/: TRDD-S3QEQBYV is complete and was moved there, so the old design/tasks path failed grep and reported a blocker that no longer held.
