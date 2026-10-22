---
trdd-id: ABPSC16L
title: EV-01 Dataset format and fingerprint
column: blocked
status: tasked
created: 2026-10-07T20:29:01+0200
updated: 2026-10-10T15:08:20+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:01+0200
implementation-commits: [1bb5661d]
blocked-by: [PCZZCDSR]
pre-block-column: dev
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_202836+0200-PCZZCDSR-wk-02-benchmark-workload-kit-ts.md
blocker-holds-if: exit-0
unblock-when: [trdd:PCZZCDSR]
---

# EV-01 Dataset format and fingerprint

## Goal
Define the labelled dataset format for `classify-eval`: one jsonl file per decision spec, with a fingerprint.

## Approval log

- 2026-10-07T20:29:01+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:08+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T15:06:31+0200 — column → blocked. audit 2026-10-10: code committed in 1bb5661d; the private fingerprint copy must be replaced by the WK-02 kit (TRDD-PCZZCDSR); the definition-of-done subject clause also needs the owner ruling; nobody working it
- 2026-10-10 note: when the WK-02 block clears this card still needs the owner ruling on the definition-of-done clause (one commit with the card id in its subject); do not return it to dev unworked.

## Plan refs

§11 (`classify-eval` row), §16 (EV table), D3, D12, D16.

## Depends on

WK-02 (TRDD-PCZZCDSR)

## Files

- To be listed at card start (dataset loader/fingerprint code, its test, vitest include entry).

## Reuse

`benchmark/workload-kit.ts` dataset/fingerprint step (WK-02). Read the code at card start.

## Steps

1. Define the jsonl record shape per decision spec (derived from done-when).
2. Reuse the kit's dataset/fingerprint step to fingerprint each file (derived from §11).
3. Test loading and fingerprint stability (derived from done-when).

## Acceptance

- [x] jsonl per spec
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Dataset content (EV-02 to EV-04), metrics (EV-05).

## Notes

2026-10-10: dataset.ts (one jsonl file per spec, sha1 12-hex fingerprint over non-blank lines) committed in 1bb5661d (classify-eval/dataset.test.ts); box 1 ticked on that file. definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id; open: WK-02 kit must replace the private fingerprint copy. Report: docs_dev/20261010-EV-01-DW-01-report.md
