---
trdd-id: 5D4X8KFN
title: BR-08 Step loop and statuses
column: backburner
status: tasked
created: 2026-10-07T20:01:10+0200
updated: 2026-10-07T20:01:14+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:10+0200
---

# BR-08 Step loop and statuses

## Goal

The browse step loop with the source's statuses plus `budget`, a deadline and the opt-in cost cap.

## Approval log

- 2026-10-07T20:01:10+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (statuses `done`, `goal_achieved`, `stuck`, `max_steps`, `timeout`, `blocked`, `error` with `aborted` reason, plus our `budget`; per-step fan-out: action choice, goal-achieved noul, stuck noul; second-stage dropdown; no extra call for no-op recovery; result keeps the jev-browser shape inside the llm-ext envelope), D2 (no default cap; `--max-budget` opt-in; the run ends with status `budget` when the next step would pass it), E86 (browse part), E109, E110.

## Depends on

BR-07 (TRDD-7YYSPLX0), L0-03 (TRDD-CF4A029M)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

L0 transport retry loop (L0-03), L2 deadline and cost cap (`l2/cost-cap.ts`); read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Implement the loop: action choice over pruned elements, goal-achieved noul, stuck noul per step.
3. Emit the statuses listed in §10 and close the browser in `finally` on each.
4. Apply the deadline; apply the cost cap only when `--max-budget` is passed (no default cap).
5. Parse numeric flags strictly: a non-number is refused at parse (E110).
6. A chosen id that is not a known action is an invalid answer and is never executed (E109).

## Acceptance

- [ ] statuses of §10
- [ ] deadline
- [ ] cost cap (opt-in `--max-budget`; no default cap)
- [ ] E109: Jev picks an unknown action id → invalid answer, never executed
- [ ] E110: numeric flag given a non-number (source yields NaN) → refused at parse
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Executors (BR-09), stuck rules (BR-16), no-op recovery (BR-25).
