---
trdd-id: ZBMRKOI3
title: C4-05 classify decide --hook (Claude Code PreToolUse adapter)
column: backburner
status: tasked
created: 2026-10-07T20:00:21+0200
updated: 2026-10-07T20:00:24+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:21+0200
---

# C4-05 classify decide --hook (Claude Code PreToolUse adapter)

## Goal

The `--hook` adapter of `classify decide`, a Claude Code PreToolUse hook that defers on any failure.

## Approval log

- 2026-10-07T20:00:21+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

D1 (defer: empty stdout, exit 0, stderr notice), §9 row `classify decide` (`--hook`: Claude Code PreToolUse adapter, jev-mcp examples/hook-gate.mjs), DOC-07 consumes it (`hook-gate.md`).

## Depends on

C4-01 (TRDD-BUL4EEBP), SP-06 (TRDD-N1FQ8A8K)

## Files

`scripts/llm-ext/src/classifiers/commands/hook.ts` (create, §3); test file and vitest include entry: to be listed at card start.

## Reuse

Read the code at card start; read jev-mcp `examples/hook-gate.mjs` in a local clone of the jev-mcp repository.

## Steps

1. Read the cited section of the jev-mcp inventory report and the source lines it cites, in a clone of the jev-mcp repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Read hook JSON on stdin, run the `decide` spec, print the PreToolUse decision (derived from done-when).
3. On any error the hook defers: empty stdout, exit 0, a notice on stderr (D1).
4. A tool not covered by the policy makes no call and prints empty stdout.
5. The hook's own deadline is shorter than the Claude Code hook timeout and defers per D1.

## Acceptance

- [ ] E77: `decide --hook`: malformed stdin JSON → D1 behaviour, reported on stderr
- [ ] E78: `decide --hook`: tool not covered by the policy → no call, empty stdout
- [ ] E79: `decide --hook`: own deadline vs Claude Code hook timeout → own deadline shorter, defers per D1
- [ ] D1 behaviour (defer, empty stdout, exit 0, stderr notice)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The `decide` spec (SP-06), the hook documentation (DOC-07).
