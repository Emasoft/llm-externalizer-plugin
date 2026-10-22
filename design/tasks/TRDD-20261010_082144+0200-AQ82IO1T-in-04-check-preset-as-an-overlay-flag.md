---
trdd-id: AQ82IO1T
title: IN-04 check (--preset) as an overlay flag
column: blocked
status: tasked
created: 2026-10-10T08:21:44+0200
updated: 2026-10-10T09:05:58+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:21:44+0200
implementation-commits: [6a4de637]
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
pre-block-column: dev
---

# IN-04 check (--preset) as an overlay flag

## Goal

check takes `--preset` as an overlay flag, so `--preset invariant-check` or `--preset criterion-vs-tests` selects its union branch from the command line. An unknown preset value is refused by the union schema message.

## Plan refs

Plan 289, D15.

## Depends on

- IN-03 (TRDD-DCI7C2Y7), which provides the overlay mechanism.

## Acceptance

- [x] `--preset invariant-check --input f.json` and `--preset criterion-vs-tests` run
- [x] JSON that already has `preset` plus the flag: refused
- [x] no `--preset` and no `preset` in the JSON: schema refusal names the field
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:21:44+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T09:05:58+0200 — column → blocked. 6a4de637 landed; waits on the owner ruling about test doubles (plan card ZB41KG62)

## Notes

2026-10-10T09:05:56+0200 6a4de637: check takes --preset as a spec flag; an unknown value is refused by the union schema itself (no hand-written enum). Boxes proven by input-args.test.ts describe 'check --preset as an overlay flag (IN-04)' (9 tests, all passed by name in the commit gate). Structural change: spec flags moved from cli.flags to DecisionSpec.flags, because cli switches on file inputs; check has no cli and stays JSON-only (named test). Correction to 'Depends on': the overlay mechanism landed in IN-02 (a77c0f96), not IN-03; IN-03 (79b8b5fd) added SpecFlag.type. Added scope: find --top files-mode threshold test. The check replies are the real P-01 dec-choice2 reply re-keyed through the fetch seam (no recorded check reply exists). Definition-of-done box waits on the owner ruling about test doubles.
