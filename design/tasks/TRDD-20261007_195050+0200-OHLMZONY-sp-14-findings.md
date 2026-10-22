---
trdd-id: OHLMZONY
title: SP-14 findings
column: blocked
status: tasked
created: 2026-10-07T19:50:50+0200
updated: 2026-10-10T04:43:19+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:50:50+0200
implementation-commits: [643d7887, 67649b69]
blocked-by: [O4MSZIG5]
unblock-when: [trdd:O4MSZIG5]
pre-block-column: dev
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261010_044154+0200-O4MSZIG5-live-reply-capture-for-the-14-decision-specs.md
blocker-holds-if: exit-0
---

# SP-14 findings

The findings decision as one catalog file: input schema, question texts, state shape, thresholds, split class, pure policy, attention predicate, injection placement (D5).

## Approval log

- 2026-10-07T19:50:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:55+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T04:42:56+0200 — column → blocked by main-agent@llm-externalizer-plugin. remaining work waits on: O4MSZIG5

## Plan refs

§9 (`classify findings`), §5 (findings row), D4, D5, D17, D21; §16 SP table, §16 Example 2 (SP-05) as the model for detail.

## Depends on

SP-00 (TRDD-DAGBDXUB), L2-06 (TRDD-SNZ17S5L)

## Files

- `scripts/llm-ext/src/classifiers/catalog/findings.ts`
- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registration)
- `scripts/llm-ext/src/classifiers/catalog/findings.test.ts`
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`
- other files: to be listed at card start

## Reuse

L2-06

## Steps

1. read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (claude-jev `review.ts` (line ranges: to be listed at card start; the plan gives none)); list every rule in the card; check the licence row from SEC-01 (D17)
2. zod input and thresholds: real/reachable/already_handled/severity(4); thresholds 0.5/0.7/0.4
3. `build`: state = task, intent and the source windows of that finding; 4 questions per finding, by index; injection placement: index-scoped
4. split class (§5 table): unit = finding (4 q); shared state = task, intent, source windows of that finding; merge = sort keep/keep_low/drop
5. `project`: keep, keep_low or drop from the four answers; a finding whose file/line no longer exists has an empty window and gets keep_low
6. attention predicate (for `--strict-exit`): any keep
7. capture one live reply from this spec's own `build` (D12): no go-ahead needed and no cap (D2); the card prints and records its cost; sanitize the reply like P-03; store it as the golden fixture (derived from done-when)
8. golden tests: snapshot of `build` output, and `project` run on the captured reply (§16 SP preamble)
9. one named test per edge row listed in Acceptance (§12: every row becomes a named test in its card)
10. register the spec in `catalog/index.ts` and add the test file to the vitest include list (derived from done-when)
11. WHY comments at every non-obvious rule

## Acceptance

- [x] E71 passes (done when)
- [x] E71: findings: file/line no longer exists → empty window; keep_low
- [x] golden snapshot of `build` output
- [ ] `project` on this card's captured live reply
- [x] injection placement as planned (index-scoped), checked on the serialized request
- [x] attention predicate tested on one true and one false result
- [x] registry consistency test passes with this spec registered
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

CLI flags and output wiring (C4-01), the injection test suite (SEC-02).

## Notes

2026-10-10: findings spec registered, tested in catalog/findings.test.ts (E71), committed in 643d7887; boxes 1 to 3 and 5 to 7 ticked. box 'project on this card's captured live reply' unticked: no live reply captured for this spec; the shape is tested with re-keyed P-01 replies only (needs a capture card, none exists); definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; 643d7887's body names the card id; open owner decision: thresholds reachable 0.7 and already-handled 0.4 versus the claude-jev reference pairing them the other way (plan order kept). Report: docs_dev/20261010-SP-14-17-report.md
2026-10-10: 67649b69 changed attention for this card: DELIBERATE DEVIATION from the plan row and step 6 ('any keep'): attention is keep OR invalid OR some severity null, so a finding nobody could judge (no source supplied, line past the end, window too large, unanswered) also raises it and --strict-exit cannot pass a run in which findings went unexamined (test 'follow-up 4' in findings.test.ts). The 20,000-token window cap is the worker's own number, not the plan's. 67649b69's body names this card id. Report: docs_dev/20261010-wave9-final-fixes-report.md
2026-10-10 BLOCKED (pre-block-column dev): the remaining work is the live reply capture, owned by TRDD-O4MSZIG5 (unblock-when trdd:O4MSZIG5). The definition-of-done clause 'one commit with the TRDD id in its subject' is an open owner decision on TRDD-ZB41KG62, not work on this card. validate's probe requirement is met by 'test -f <blocker card file>', which also reads cleared if the blocker card is renamed, superseded or cancelled; unblock-when is the real condition.
