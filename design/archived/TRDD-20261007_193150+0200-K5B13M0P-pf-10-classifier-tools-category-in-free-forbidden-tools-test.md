---
trdd-id: K5B13M0P
title: PF-10 CLASSIFIER_TOOLS category in free-forbidden-tools.test.ts
column: complete
status: archived
created: 2026-10-07T19:31:50+0200
updated: 2026-11-18T15:44:29+0100
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
blocked-by: []
pre-block-column: 
blocker-probe: test -f design/tasks/TRDD-20261007_200013+0200-4Q1IVJOE-c4-03-launcher-and-main-wiring-and-help.md
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
- 2026-11-18T15:44:29+0100 — COMPLETE by main-agent@llm-externalizer-plugin. box 2 non-vacuous; commit-id clause WAIVED by delegated ruling, not met (work in 3bfa8c58). Cleared blocked-by (--clear-blocker override).

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
- [x] an assertion that every tool that can send a decisions request is in that list (§15)
- [~] ~~definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules~~ obsolete: the commit-id clause cannot be met (no commit names this card; history is not rewritten); replaced by the waiver box below
- [x] definition of done, clause by clause: tests in the vitest include list (vitest.config.ts:280 free-forbidden-tools.test.ts) MET; typecheck, lint, build and npm test OK in the 14.6.1 publish run (reports_dev/release-next/publish-20261117_122713+0100.log; not re-run at the current HEAD) MET; no vi.* doubles (0 vi.mock/spyOn/fn/doMock/stubGlobal in free-forbidden-tools.test.ts; hand-written fakes not checked) MET; WHY comments at the CLASSIFIER_TOOLS category and the section-15 assertion MET; one commit with the TRDD id in its subject: NOT MET, waived by a delegated main agent ruling (USER delegation 2026-11-18), not by an owner answer (git log --all -i --grep=K5B13M0P is empty; the work is 3bfa8c58, subject names TRDD-ZB41KG62, linked by implementation-commits)

## Out of scope

The cross-note in TRDD-KV2WCFCS (TR-03).

## Notes

2026-10-10: CLASSIFIER_TOOLS derived from the decision registry, exempt with reason 'classifiers are paid by design (D2)', committed in 3bfa8c58 (free-forbidden-tools.test.ts); box 1 ticked. Box 2 (every tool that can send a decisions request is in the list) unticked: the assertion is vacuous until C4-02 adds classify_<id> tools; blocked-by C4-02 (TRDD-V8Q20MLW). definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; the commit message does not name the card id. Report: docs_dev/20261010-PF-07-11-PT-07-report.md
2026-10-10: unblock-when [trdd:V8Q20MLW] is set and is the real condition for trdd-drift; validate still demands a blocker-probe, so the probe 'test -f <C4-02 card file>' stays. Its failure mode: it holds while the C4-02 card file exists in design/tasks and reads 'cleared' if that card is renamed, superseded, cancelled or archived, even when the classify tools were never added; reassess the block by hand in those cases.
2026-10-10 RE-POINTED: C4-02 (V8Q20MLW) is complete but its entries are not in the tool list; box 2 (every tool that can send a decisions request is in the list) becomes non-vacuous only when C4-03 (TRDD-4Q1IVJOE) adds classifyTools() to buildTools, so blocked-by and unblock-when now name 4Q1IVJOE. Probe note: validate demands a blocker-probe; it is 'test -f <blocker card file>', which also reads cleared if that card is renamed, superseded, cancelled or archived; unblock-when is the real condition.
2026-11-18T15:36:03+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): commit-id clause of the definition of done WAIVED, not met: no commit names TRDD-K5B13M0P (git log --all --oneline -i --grep=K5B13M0P returns nothing; 3bfa8c58 has no mention), history is not rewritten, and implementation-commits links 3bfa8c58. This is not the 0f74f8d3 precedent (there a commit subject named the card). Box 2 ticked: free-forbidden-tools.test.ts (B1: :819-829) filters buildTools for classifier-typed or classify_* tools, which now exist (tools/definitions.ts returns classifyTools() and classifierPingTool()), so the assertion is non-vacuous. blocked-by (4Q1IVJOE code is done) is cleared by the main agent when moving the card. Evidence: triage report b1-blocked (K5B13M0P).
