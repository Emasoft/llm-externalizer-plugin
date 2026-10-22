---
trdd-id: M8GT4AYB
title: IN-08 label text output (--only, --verbose) and --save for label
column: backburner
status: tasked
created: 2026-10-10T08:23:42+0200
updated: 2026-10-10T08:28:29+0200
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

- [ ] count line `a 3 . b 1`
- [ ] `--only a,b` hides other groups
- [ ] `--verbose` lists every item with confidence and `?` marks
- [ ] low-confidence section with runner-up
- [ ] `--save`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:23:42+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:28:29+0200 — column → backburner. depends on IN-07 (LWDKZO2A), which waits on open question Q4
