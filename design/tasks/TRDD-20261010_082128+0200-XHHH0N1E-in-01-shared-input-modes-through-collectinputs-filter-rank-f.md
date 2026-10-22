---
trdd-id: XHHH0N1E
title: IN-01 Shared input modes through collectInputs (filter, rank, find)
column: blocked
status: tasked
created: 2026-10-10T08:21:28+0200
updated: 2026-10-10T09:05:59+0200
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
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
pre-block-column: dev
implementation-commits: [b159d89b]
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

## Notes

2026-10-10T08:32:32+0200 b159d89b: IN-01 classify filter, rank and find take files, directories, globs, -, --items, --lines, --ext, --limit, --max-bytes and --follow-symlinks through collectInputs, and the 23 input-args tests pass. Deviation from qs.mjs:64-77: a leading single-dash word is refused (did you mean --x? when such a flag exists) so a typo cannot become a paid question. Definition-of-done box waits on the owner ruling about test doubles (category c).
2026-10-10T08:34:52+0200 Boxes 'rank and find ... still parse as thresholds' and 'classifyArgv ... definitions.ts advertises ...' stay unticked: only rank --top and the classifyArgv booleans are proven by named tests; --keep-at, --chunk, --min-score and the definitions part need a named test each (small follow-up).
2026-10-10T08:35:32+0200 Correction to the previous note: the classifyArgv/definitions box is proven by input-args.test.ts:329 (--lines and --follow-symlinks take no value) and definitions-classify.test.ts 'an entry carries exactly the spec's thresholds plus the shared flags' (INPUT_FLAGS only for specs with cli); ticked. The threshold box (rank --keep-at, find --chunk/--min-score in files mode) gets its named test in IN-03 (DCI7C2Y7).
2026-10-10T08:59:38+0200 Threshold box: rank --keep-at, rank --top, find --chunk and --min-score now have named files-mode tests (79b8b5fd, input-args.test.ts IN-03 describe); find --top in files mode still has no named test, so the box stays unticked.
2026-10-10T09:05:56+0200 Threshold box ticked: find --top now has a named files-mode test (6a4de637, 'find --top 2 still parses as a threshold in files mode'), joining rank --keep-at/--top and find --chunk/--min-score (79b8b5fd) and the mode files assertions (input-args.test.ts:158,160). The find --top test proves the value is not taken as an input path; it does not assert the top-2 limit's effect.
