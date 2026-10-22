---
trdd-id: MBGNPPNB
title: SP-21 browse-dropdown
column: backburner
status: tasked
created: 2026-10-07T19:51:36+0200
updated: 2026-10-07T19:52:21+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:51:36+0200
---

# SP-21 browse-dropdown

The browse-dropdown decision as one catalog file: input schema, question texts, state shape, thresholds, split class, pure policy, attention predicate, injection placement (D5).

## Approval log

- 2026-10-07T19:51:36+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§9 (`browse run`), §5 (browse dropdown row), §10, D5, D17, D18, D21; §16 SP table, §16 Example 2 (SP-05) as the model for detail.

## Depends on

SP-00 (TRDD-DAGBDXUB)

## Files

- `scripts/llm-ext/src/classifiers/catalog/browse-dropdown.ts`
- `scripts/llm-ext/src/classifiers/catalog/index.ts` (registration)
- `scripts/llm-ext/src/classifiers/catalog/browse-dropdown.test.ts`
- the vitest include entry in `scripts/llm-ext/vitest.config.ts`
- other files: to be listed at card start

## Reuse

none

## Steps

1. read the cited lines in a clone of the source repository at the commit SEC-01 records; if no copy is present, clone it at that commit (jev-browser source lines for the dropdown decision (line ranges: to be listed at card start; the plan gives none here)); list every rule in the card; check the licence row from SEC-01 (D17)
2. zod input and thresholds: dropdown choice over the options of one dropdown
3. `build`: state = dropdown state (page text in state); injection placement: page text in state
4. split class (§5 table): unsplittable: all; a dropdown with more options than one request holds is trimmed per the BR-07 rule and flagged
5. `project`: chosen option to a result; trimming flagged
6. attention predicate (for `--strict-exit`): status other than done or goal_achieved (browse run)
7. capture one live reply from this spec's own `build` (D12): no go-ahead needed and no cap (D2); the card prints and records its cost; sanitize the reply like P-03; store it as the golden fixture (derived from done-when)
8. golden tests: snapshot of `build` output, and `project` run on the captured reply (§16 SP preamble)
9. one named test per edge row listed in Acceptance (§12: every row becomes a named test in its card)
10. register the spec in `catalog/index.ts` and add the test file to the vitest include list (derived from done-when)
11. WHY comments at every non-obvious rule

## Acceptance

- [ ] E95 passes (done when)
- [ ] E95: dropdown with more options than one request holds → dropdown spec trims per BR-07 rule, flagged
- [ ] golden snapshot of `build` output
- [ ] `project` on this card's captured live reply
- [ ] injection placement as planned (page text in state), checked on the serialized request
- [ ] attention predicate tested on one true and one false result
- [ ] registry consistency test passes with this spec registered
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

CLI flags and output wiring (C4-01), the injection test suite (SEC-02); the browse loop (BR cards).
