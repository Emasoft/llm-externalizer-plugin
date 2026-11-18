---
trdd-id: M8GT4AYB
title: IN-08 label text output (--only, --verbose) and --save for label
column: backburner
status: tasked
created: 2026-10-10T08:23:42+0200
updated: 2026-11-18T16:53:11+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:23:42+0200
implementation-commits: [72c0a3a0, c4dc6bd5]
---

# IN-08 label text output (--only, --verbose) and --save for label

## Goal

label prints its text output: a count line, `--only` to show chosen groups, `--verbose` to list every item with its confidence, a low-confidence section with the runner-up label, and `--save` for its per-item results.

## Plan refs

Plan 281; qs:1013-1052.

## Depends on

- IN-07 (TRDD-LWDKZO2A), which provides the text output.
- IN-02 (TRDD-LMSYDGVB), which provides the label flags and file inputs.

## Acceptance

- [x] count line `a 3 . b 1`
- [x] `--only a,b` hides other groups
- [x] `--verbose` lists every item with confidence and `?` marks
- [x] low-confidence section with runner-up
- [x] `--save`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:23:42+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:28:29+0200 — column → backburner. depends on IN-07 (LWDKZO2A), which waits on open question Q4

## Notes

2026-11-18T16:53:09+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): IN-08 evidenced. 72c0a3a0 is a pre-squash history pointer (on release/13.6.1, not an ancestor of HEAD); evidence is c4dc6bd5 (v14.3.0) plus the HEAD test label.test.ts:281-325 (IN-08 label: text form); no vi import. The count-line separator is a middle dot (label.test.ts:292 expects "bug 2 · feat 2"); the plan literal a 3 . b 1 is read as the format, not the glyph. Single-file run 2026-11-18 from scripts/llm-ext: src/classifiers/catalog/label.test.ts 47 passed, exit 0. publish 14.7.2 npm test OK.
