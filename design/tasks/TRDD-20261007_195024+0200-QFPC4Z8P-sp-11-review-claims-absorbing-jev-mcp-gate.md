---
trdd-id: QFPC4Z8P
title: SP-11 review (+ --claims, absorbing jev-mcp gate)
column: blocked
status: tasked
created: 2026-10-07T19:50:24+0200
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
approval-datetime: 2026-10-07T19:50:24+0200
implementation-commits: [643d7887]
blocked-by: [O4MSZIG5]
unblock-when: [trdd:O4MSZIG5]
pre-block-column: dev
blocker-probe: test -f /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261010_044154+0200-O4MSZIG5-live-reply-capture-for-the-14-decision-specs.md
blocker-holds-if: exit-0
---

# SP-11 review (+ --claims, absorbing jev-mcp gate)

The review (+ --claims, absorbing jev-mcp gate) decision as one catalog file: input schema, question texts, state shape, thresholds, split class, pure policy, attention predicate, injection placement (D5).

## Approval log

- 2026-10-07T19:50:24+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:27:48+0200 — column → dev by main-agent@llm-externalizer-plugin. wave 9 code committed; acceptance boxes ticked by evidence, remaining boxes owed
- 2026-10-10T04:42:53+0200 — column → blocked by main-agent@llm-externalizer-plugin. remaining work waits on: O4MSZIG5

## Plan refs

§9 (`classify review`), §5 (review rows), D5, D17, D21, D27; §16 SP table, §16 Example 2 (SP-05) as the model for detail.

## Depends on

SP-00 (TRDD-DAGBDXUB), L2-06 (TRDD-SNZ17S5L), L2-19 (TRDD-PXVVVPYV)

## Files

- `scripts/llm-ext/src/classifiers/catalog/review.ts`
- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registration)
- `scripts/llm-ext/src/classifiers/catalog/review.test.ts`
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`
- other files: to be listed at card start

## Reuse

L2-06, L2-19

## Steps

1. read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (jev-mcp `server.ts:1473-1880` (review) and `server.ts:1882-2126` (gate, under `--claims`)); list every rule in the card; check the licence row from SEC-01 (D17)
2. zod input and thresholds: 4 scores plus `safe_to_apply`, composite, reason codes; `--claims` adds the gate's claim checks and reason codes; whole-diff and per-file modes
3. `build`: state = diff, request, evidence (whole) or file chunks plus request and tests (per-file); whole-diff review truncates-and-flags in `build`; claims by index; injection placement: index-scoped
4. split class (§5 table): whole: unit = claim (with `--claims`), shared state = diff, request, evidence, merge = review compose plus claims, unsplittable: review half; per-file: unit = file chunk, shared state = request, tests, merge = highest risk per file then per-file compose, renumber `files[i]`
5. `project`: composite and reason codes; routes to review and never authorises (scores uncalibrated); gate's claim checks and reason codes reproduced under `--claims`
6. attention predicate (for `--strict-exit`): action other than auto
7. capture one live reply from this spec's own `build` (D12): no go-ahead needed and no cap (D2); the card prints and records its cost; sanitize the reply like P-03; store it as the golden fixture (derived from done-when)
8. golden tests: snapshot of `build` output, and `project` run on the captured reply (§16 SP preamble)
9. one named test per edge row listed in Acceptance (§12: every row becomes a named test in its card)
10. register the spec in `catalog/index.ts` and add the test file to the vitest include list (derived from done-when)
11. WHY comments at every non-obvious rule

## Acceptance

- [x] E68-E70 pass (done when)
- [x] whole and per-file
- [x] gate's claim checks and reason codes reproduced under `--claims`
- [x] E68: review: empty diff → refused
- [x] E69: review: binary hunks → skipped with warning
- [x] E70: `review --claims` with no claims → review half only
- [x] golden snapshot of `build` output
- [ ] `project` on this card's captured live reply
- [x] injection placement as planned (index-scoped), checked on the serialized request
- [x] attention predicate tested on one true and one false result
- [x] registry consistency test passes with this spec registered
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

CLI flags and output wiring (C4-01), the injection test suite (SEC-02).

## Notes

2026-10-10: review spec with --claims registered and aligned with jev-mcp, tested in catalog/review.test.ts (E68, E69, E70), committed in 643d7887; boxes 1 to 7 and 9 to 11 ticked. Box 3 (gate's claim checks and reason codes under --claims) is proven by the describe 'SP-11 review: project, --claims (jev-mcp jev_gate, lib.ts:407-415, server.ts:2064-2112)' in review.test.ts: 'verified at auto_accept confidence is auto...', 'verified below auto_accept: review (claim_confidence_below_auto_accept)...', 'contradicted at high confidence escalates...', 'unsupported goes to review, never auto', 'unknown confidence escalates...', 'a truncated gate never auto-verifies...', 'several claims: the worst action wins...'. box 'project on this card's captured live reply' unticked: no live reply captured for this spec; the shape is tested with re-keyed P-01 replies only (needs a capture card, none exists); definition-of-done box (text: tests in the vitest include list, typecheck, lint and npx eslint . --quiet clean, full npm test green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules) stays unticked: met are the include-list entry and the clean typecheck, lint and full suite at 643d7887 (4620 tests) and 67649b69 (4635 tests); unmet is 'one commit with the TRDD id in its subject' (the subjects carry TRDD-ZB41KG62); commit traceability: implementation-commits on this card; 643d7887's body names the card id; open: claims with per-file review are refused; SCORE_POLICY accepts a missing probability list for claim choices; ties go to review where the reference auto-accepts. Report: docs_dev/20261010-SP-10-11-13-report.md
2026-10-10 rename for later readers: the threshold keys are hyphenated: auto-accept, review-at, composite-floor.
2026-10-10 BLOCKED (pre-block-column dev): the remaining work is the live reply capture, owned by TRDD-O4MSZIG5 (unblock-when trdd:O4MSZIG5). The definition-of-done clause 'one commit with the TRDD id in its subject' is an open owner decision on TRDD-ZB41KG62, not work on this card. validate's probe requirement is met by 'test -f <blocker card file>', which also reads cleared if the blocker card is renamed, superseded or cancelled; unblock-when is the real condition.
