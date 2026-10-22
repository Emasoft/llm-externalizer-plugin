---
trdd-id: EVORI1LK
title: Per-command inputs and input modes for the classify commands
column: superseded
status: archived
created: 2026-10-10T05:03:43+0200
updated: 2026-10-10T08:23:59+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T05:03:43+0200
superseded-by: [XHHH0N1E,LMSYDGVB,DCI7C2Y7,AQ82IO1T,G168KDE1,17FAR6HF,LWDKZO2A,M8GT4AYB,2N4JVQI8]
---

# Per-command inputs and input modes for the classify commands

## Goal

Give the classify commands their per-command input flags and the shared input modes, which today are parsed by nothing: runDecisionArgv takes only --input or stdin JSON, the shared flags and the spec thresholds.

## Plan refs

Section 9 (intro paragraph 'Input modes shared by every command' and the command table, plan lines 271-297); D15, D27, D29; E33, E34, E41, E70, E72.

## Depends on

C4-03 (TRDD-4Q1IVJOE). Not owned here: ask inputs (C4-04), decide --hook (C4-05), ping --no-call (C4-07), -o and --strict-exit (C4-09).

## Flags and modes (with the plan line for each)

- filter: --no-collapse, --save, --lines repeat-collapsing (plan line 279: qs filter ... --lines repeat-collapsing with --no-collapse, --save)
- label: --labels "a:hint,b", --labels-json, 2-255 labels, --default, --min-confidence, --only, --verbose (plan line 281)
- rank: --top, --all, --head N, --keep-at P (plan line 283; E34, E72)
- review: --claims (plan line 287; E70)
- check: --preset invariant-check or criterion-vs-tests (plan line 289; D15)
- shared input modes: files, directories, globs, - (stdin), --items, --lines (plan section 9 intro; E33, E41)

Constraint: each flag is declared in the catalog spec or the shared input layer, never parsed ad hoc in the launcher.

## Acceptance

- [ ] filter: --no-collapse, --save and --lines work end to end
- [ ] label: --labels, --labels-json, --default, --min-confidence, --only, --verbose work end to end
- [ ] rank: --top, --all, --head, --keep-at work end to end
- [ ] review: --claims works end to end
- [ ] check: --preset works end to end
- [ ] shared input modes: files, directories, globs, stdin, --items, --lines
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T05:03:43+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T05:29:10+0200 — column → todo by main-agent@llm-externalizer-plugin. the launcher is committed (5f282fff)
- 2026-10-10T08:23:59+0200 — SUPERSEDED by main-agent@llm-externalizer-plugin. split into atomic cards IN-01..IN-09.

## Notes

2026-10-10T08:23:55+0200 Split into atomic cards IN-01..IN-09 (XHHH0N1E, LMSYDGVB, DCI7C2Y7, AQ82IO1T, G168KDE1, 17FAR6HF, LWDKZO2A, M8GT4AYB, 2N4JVQI8), per docs_dev/20261010_082500+0200-EVORI1LK-input-modes-design-note.md; this card is superseded by them.
