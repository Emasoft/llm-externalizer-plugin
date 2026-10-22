---
trdd-id: APQ601NV
title: C4-12 Receipt line and lifetime totals
column: backburner
status: tasked
created: 2026-10-07T20:00:42+0200
updated: 2026-10-07T20:00:45+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:42+0200
---

# C4-12 Receipt line and lifetime totals

## Goal

Print quicksilver's receipt as the last line of every classify command and record lifetime Jev totals in llm-ext's usage history.

## Approval log

- 2026-10-07T20:00:42+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§9 receipt paragraph (items scanned, skipped files, time, Jev tokens and cost, model, "~N Claude tokens not read"; qs I:881-894; stderr under `--json`; lifetime totals go into llm-ext's usage history, L1-10, D31), E132, D2 (every run prints its cost).

## Depends on

C4-01 (TRDD-BUL4EEBP), L1-10 (TRDD-TD6XP9GE)

## Files

To be listed at card start.

## Reuse

`recordRequest`, `withUsageContext` (plan §3 L1); the L1-10 usage record (`l1/usage.ts`). Otherwise read the code at card start.

## Steps

1. Read qs.mjs I:881-894 in quicksilver 0.3.0 for the receipt format.
2. Print the receipt as the last line: items, skipped, time, Jev tokens and cost, model, "~N Claude tokens not read (estimated)"; under `--json` it goes to stderr.
3. Mark the "not read" figure as an estimate; an estimate is never used as chart data, only RD-06's measured numbers are.
4. Add the note for input under about 1,000 tokens (E132).
5. Write lifetime Jev totals into the existing usage history and stats (D31: no separate `status` command).

## Acceptance

- [ ] qs receipt format (items, skipped, time, Jev tokens and cost, model, "~N Claude tokens not read (estimated)")
- [ ] an estimate never used as chart data, only RD-06's measured numbers are
- [ ] stderr under `--json`
- [ ] lifetime Jev totals in the existing usage history and stats
- [ ] E132: input under ~1,000 tokens → runs, and the receipt notes Claude could read it directly for less (cost study break-even)
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The usage record (L1-10), README charts (RD-06).
