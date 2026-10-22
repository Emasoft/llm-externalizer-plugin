---
trdd-id: LMS3JT0C
title: PF-05 Classifier rows of acceptedProfileTypes
column: backburner
status: tasked
created: 2026-10-07T19:31:16+0200
updated: 2026-10-10T07:52:19+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:31:16+0200
implementation-commits: [3c3db86f]
---

# PF-05 Classifier rows of acceptedProfileTypes

## Goal
Add the classifier rows to `acceptedProfileTypes`.

## Approval log

- 2026-10-07T19:31:16+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T04:56:02+0200 — column → dev by main-agent@llm-externalizer-plugin. PF-05 dispatched: C4-02 entries committed in 6cc2a9ad, the classifier rows and the wiring into buildTools are next
- 2026-10-10T05:28:46+0200 — column → backburner by main-agent@llm-externalizer-plugin. classify rows done in 3c3db86f; the remaining box needs browse run, which does not exist

## Plan refs

§8 (command × type table rows `classify *` and `browse run`), D37.

## Depends on

PT-03 (TRDD-B9FWID59), C4-02 (TRDD-V8Q20MLW)

## Files

- `scripts/llm-ext/src/tools/definitions.ts`
- tests and the vitest include entry: to be listed at card start

## Reuse

- the PT-03 field and runtime check
- read the code at card start for the `classify` command registrations (C4-02)

## Steps

1. Set every `classify` command's `acceptedProfileTypes` to classifier only.
2. Set `browse run`'s decisions profile (`--profile`) to classifier only.
3. Set `browse run --typing-profile` to local, free, paid.
4. Add WHY comments.

## Acceptance

- [ ] every `classify` command and `browse run`'s decisions profile accept only `classifier`
- [ ] `browse run --typing-profile` accepts local/free/paid
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The generic table and runtime check (PT-03), command implementations (C4 cards).

## Notes

2026-10-10: classifier-only profile rows for every classify tool (classifierProfileRows, spread into ACCEPTED_PROFILE_TYPES; definitions-classify.test.ts), committed in 3c3db86f. Box 1 NOT ticked: it names both the classify rows (done) and 'browse run decisions profile', and a browse run command does not exist in the code. Box 2 (browse run --typing-profile) not applicable until it exists. The coordinator's move reason ('wiring into buildTools next') is superseded: the wiring moved to C4-03 (TRDD-4Q1IVJOE). No single BR card clearly creates the browse run command; candidates: BR-07 step loop TRDD-5D4X8KFN, BR-03 gating TRDD-TRDGXSF0 (gates an existing command), BR-10 typing TRDD-FH0BQUZZ (owns --typing-profile). Left in dev. Report: docs_dev/20261010-PF-05-report.md
2026-10-10 CORRECTION (commit 5f282fff message claimed 'the ONE existing profile-type refusal applies' for classify): wrong. The classifier-only rows made here are the DECLARATION / help surface; the enforcement is the runner's own selectClassifierProfile (classifiers/l2/profile.ts), because main.ts skips the general profile-type check for classify. A test tying the rows to the runner refusal landed in 1c08c7ff (TRDD-4Q1IVJOE).
Parked in backburner: the remaining box ('browse run' decisions profile / --typing-profile) needs the 'browse run' command, which does not exist; revisit when it does (BR-07 TRDD-5D4X8KFN, BR-10 TRDD-FH0BQUZZ).
2026-10-10T07:31:08+0200 current state: backburner. The earlier line "Left in dev" is superseded.
