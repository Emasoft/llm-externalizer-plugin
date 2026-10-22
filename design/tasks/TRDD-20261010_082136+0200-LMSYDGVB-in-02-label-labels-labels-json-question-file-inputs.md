---
trdd-id: LMSYDGVB
title: IN-02 label (--labels, --labels-json, --question, file inputs)
column: blocked
status: tasked
created: 2026-10-10T08:21:36+0200
updated: 2026-10-10T08:48:23+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:21:36+0200
implementation-commits: [a77c0f96, 04e9b517]
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
pre-block-column: dev
---

# IN-02 label (--labels, --labels-json, --question, file inputs)

## Goal

label takes its classes from `--labels "a:hint,b"` or `--labels-json` (a JSON object or @file), and its items from the shared file input modes, so `classify label` runs end to end over files, directories, globs and stdin. --question is out of scope (open question Q2).

## Plan refs

Plan 281; E41 (`@dir` refused); qs:986-996, 998-1010.

## Depends on

- IN-01 (TRDD-XHHH0N1E)

## Acceptance

- [x] both label forms produce the classes
- [x] 1 or 256 labels refused by the schema
- [x] `--default` of a non-label refused (the --default check in run-decision.ts run())
- [x] `@dir` refused (E41)
- [x] chunked file item takes the default-label no-vote rule (E117)
- [x] `classify label --labels a,b <files>` runs end to end through runDecisionArgv, items from collectInputs
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:21:36+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:43:21+0200 — column → blocked by main-agent@llm-externalizer-plugin. a77c0f96 landed; waits on the owner ruling about test doubles (plan card ZB41KG62)

## Notes

- --question (qs:1001) is not in the plan's label row; porting it and its target field are open question Q2, outside this card
2026-10-10T08:43:18+0200 a77c0f96: classify label takes --labels / --labels-json (inline or @file under the named-file rules) and file inputs; boxes proven by input-args.test.ts (labels parsing, labels-json and @file, named-file refusals, 1 and 256 labels, --default, E117 no-vote, end to end). Deviation from qs: a repeated label is refused instead of the last winning. The JSON-input overlay of spec flags landed here (planned for IN-03). Definition-of-done box waits on the owner ruling about test doubles (category c: injected readStdin and writers).
2026-10-10T08:44:06+0200 pre-block-column set to dev: the card was worked from todo (code in a77c0f96), so a release must put it back in dev.
2026-10-10T08:48:22+0200 04e9b517 (follow-up): --labels refuses an empty label naming --labels; labels with spaces are accepted as typed (only item ids are restricted); overlay errors that are not refusals rethrow and print as one llm-ext line (main.ts top-level handler), not as a user refusal. Gate green: build, tsc, eslint, 4808 tests passed.
