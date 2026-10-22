---
trdd-id: DCI7C2Y7
title: IN-03 rank (--all, --head) as spec-declared input flags
column: blocked
status: tasked
created: 2026-10-10T08:21:40+0200
updated: 2026-10-10T08:59:40+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:21:40+0200
implementation-commits: [79b8b5fd]
blocked-by: [ZB41KG62]
unblock-when: [decision:test-doubles-ruling]
blocker-probe: 'grep -qF OWNER-RULING-test-doubles: /Volumes/EmaUITEK4TBSSD/Code/llm-externalizer/llm-externalizer-plugin/design/tasks/TRDD-20261007_050214+0200-ZB41KG62-classifiers-command-group-system-one-inference-with-the-jev-.md'
blocker-holds-if: exit-nonzero
pre-block-column: dev
---

# IN-03 rank (--all, --head) as spec-declared input flags

## Goal

rank gets `--all` and `--head N` as flags declared on its spec, so the full listing and the head-only send work from the command line and in JSON mode.

## Plan refs

Plan 283, 361, 399 (E34, E72), D27.

## Depends on

- IN-02 (TRDD-LMSYDGVB), which adds the SpecFlag mechanism.

## Acceptance

- [x] `--head N` sends only the first N bytes of a longer file and the whole shorter one
- [x] `--all` lists every candidate
- [x] `--head 1500 --keep-at 0.5` (D27 form) runs
- [x] flags valid in JSON mode too (overlay), refused if the JSON already holds the field
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:21:40+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:59:40+0200 — column → blocked. 79b8b5fd landed; waits on the owner ruling about test doubles (plan card ZB41KG62)

## Notes

2026-10-10T08:35:32+0200 Also owed here (from IN-01 XHHH0N1E): a named test that rank --keep-at and find --chunk/--min-score still parse as thresholds in files mode; then tick IN-01's threshold box.
2026-10-10T08:43:18+0200 Scope trimmed: the JSON-input overlay of spec flags landed in IN-02 (a77c0f96); this card keeps rank --all and --head as spec flags, plus the threshold-parse test owed from IN-01.
2026-10-10T08:59:38+0200 79b8b5fd: rank --head N and --all are spec flags (CLI and JSON overlay). Boxes proven by input-args.test.ts describe 'rank --head and --all as spec flags (IN-03)' (12 tests) plus classify-launch.test.ts (classifyArgv with --all; registry guard); all 14 passed by name in the commit gate. --head cuts at most N bytes at a character boundary. Mechanism change: SpecFlag.type (boolean|number); boolean flags take no value and parse is not called. Added scope: --head 0/-1/1.5/abc refusals, --all=x and repeated boolean refused, tool-schema types, registry guard, classifyArgv treats boolean spec flags as valueless (launcher.ts). The IN-02 dependency is met in code by a77c0f96; IN-02's blocked column is only the definition-of-done ruling. Definition-of-done box waits on the owner ruling about test doubles (the input-args harness injects readStdin, writers and settings).
