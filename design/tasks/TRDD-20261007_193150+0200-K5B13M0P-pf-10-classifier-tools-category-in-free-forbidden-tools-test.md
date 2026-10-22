---
trdd-id: K5B13M0P
title: PF-10 CLASSIFIER_TOOLS category in free-forbidden-tools.test.ts
column: blocked
status: tasked
created: 2026-10-07T19:31:50+0200
updated: 2026-10-10T05:02:47+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:50+0200
implementation-commits: [3bfa8c58]
blocked-by: [4Q1IVJOE]
pre-block-column: dev
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_200013+0200-4Q1IVJOE-c4-03-launcher-and-main-wiring-and-help.md
blocker-holds-if: exit-0
unblock-when: [trdd:4Q1IVJOE]
---

# PF-10 CLASSIFIER_TOOLS category in free-forbidden-tools.test.ts

## Goal
Add a `CLASSIFIER_TOOLS` category, derived from the catalog registry, to `free-forbidden-tools.test.ts`, exempt from the free-only rule with the reason "classifiers are paid by design (D2)".

## Approval log

- 2026-10-07T19:31:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:13+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T04:38:29+0200 — column → blocked by main-agent@llm-externalizer-plugin. box 2 (sender-tool assertion) is vacuous until C4-02 TRDD-V8Q20MLW adds classify tools

## Plan refs

§15 (KV2WCFCS conflict), D2.

## Depends on

SP-00 (TRDD-DAGBDXUB)

## Files

- `free-forbidden-tools.test.ts` (path to be listed at card start)
- the catalog registry from SP-00: to be listed at card start
- vitest include entry: to be listed at card start

## Reuse

- the catalog registry (SP-00)
- read the code at card start for the existing free-only rule in the test

## Steps

1. Derive `CLASSIFIER_TOOLS` from the catalog registry.
2. Exempt it from the free-only rule with the reason "classifiers are paid by design (D2)".
3. Add the §15 assertion: every tool that can send a decisions request is in that list.
4. Add WHY comments.

## Acceptance

- [x] `CLASSIFIER_TOOLS` category derived from the catalog registry, exempt from the free-only rule with the reason "classifiers are paid by design (D2)"
- [ ] an assertion that every tool that can send a decisions request is in that list (§15)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The cross-note in TRDD-KV2WCFCS (TR-03).

## Notes

2026-10-10: CLASSIFIER_TOOLS derived from the decision registry, exempt with reason 'classifiers are paid by design (D2)', committed in 3bfa8c58 (free-forbidden-tools.test.ts); box 1 ticked. Box 2 (every tool that can send a decisions request is in the list) unticked: the assertion is vacuous until C4-02 adds classify_<id> tools; blocked-by C4-02 (TRDD-V8Q20MLW). definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
2026-10-10: unblock-when [trdd:V8Q20MLW] is set and is the real condition for trdd-drift; validate still demands a blocker-probe, so the probe 'test -f <C4-02 card file>' stays. Its failure mode: it holds while the C4-02 card file exists in design/tasks and reads 'cleared' if that card is renamed, superseded, cancelled or archived, even when the classify tools were never added; reassess the block by hand in those cases.
2026-10-10 RE-POINTED: C4-02 (V8Q20MLW) is complete but its entries are not in the tool list; box 2 (every tool that can send a decisions request is in the list) becomes non-vacuous only when C4-03 (TRDD-4Q1IVJOE) adds classifyTools() to buildTools, so blocked-by and unblock-when now name 4Q1IVJOE. Probe note: validate demands a blocker-probe; it is 'test -f <blocker card file>', which also reads cleared if that card is renamed, superseded, cancelled or archived; unblock-when is the real condition.
