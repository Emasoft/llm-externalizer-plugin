---
trdd-id: 37X07EPM
title: L2-11 Opt-in spend cap --max-budget (D2)
column: complete
status: archived
created: 2026-10-07T19:22:32+0200
updated: 2026-10-10T00:53:24+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:22:32+0200
implementation-commits: [665cc7e7, e8d7d255, 0421472e]
---

# L2-11 Opt-in spend cap --max-budget (D2)

## Goal
The opt-in spend cap `--max-budget=<usd>`: a pre-run estimate check and a mid-run stop, with no check at all without the flag.

## Approval log

- 2026-10-07T19:22:32+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T00:53:14+0200 — column → todo by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:53:19+0200 — column → dev by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed
- 2026-10-10T00:53:24+0200 — COMPLETE by main-agent@llm-externalizer-plugin. USER 2026-10-09: complete the jev plan; wave-7 work committed.

## Plan refs

D2, §4 (row "Opt-in spend cap"), §3 (`l2/cost-cap.ts`); E49, E86, E87.

## Depends on

L0-08 (TRDD-MKEWC00E), L1-07 (TRDD-1V68E408)

## Files

- `scripts/llm-ext/src/classifiers/l2/cost-cap.ts`
- `scripts/llm-ext/src/classifiers/l2/cost-cap.test.ts`
- `scripts/llm-ext/vitest.config.ts`

## Reuse

`resolveModel` (L0-08, price), `estimateTokens` (L1-07). Read the code at card start.

## Steps

1. Check that no existing llm-ext command already uses a `--max-budget` flag with another meaning (done-when).
2. Without the flag no check runs and no default cap exists (D2, E49).
3. With the flag, check the estimate before the first call and refuse when it exceeds the cap (E49).
4. When the model price is unknown, refuse before any call (E87).
5. When a running cost passes the cap mid-run, stop sending the remaining requests, keep finished results, and report `stopped: "budget"` with a non-zero exit (E86).

## Acceptance

- [x] no check without the flag
- [x] step 1 confirmed that no existing llm-ext command uses a `--max-budget` flag with another meaning
- [x] E49: `--max-budget` given and the estimate exceeds it → refused before any call; without `--max-budget` no check runs (D2)
- [x] E86: `--max-budget` given and a running cost passes it mid-run → remaining requests are not sent; finished results kept; the classify result envelope carries `stopped: "budget"` (browse: status `budget`) and the command exits non-zero
- [x] E87: `--max-budget` given and the model's price is unknown → refused before any call (the estimate cannot be checked)
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules
RESULT 2026-10-10: committed 665cc7e7 (fourth of the four commits L2-14, L2-13, L2-16, L2-11), e8d7d255 (test include list), 0421472e (rebuilt dist) — l2/cost-cap.ts (checkEstimate, BudgetTracker, BUDGET_EXIT_CODE = 1), l2/cost-cap.test.ts. No existing command uses --max-budget; no check without the flag; E49, E87 refuse before any call; E86 tracker marks stopped budget (the fan-out calling exceeded() before each request is wiring in other cards). The estimate is input-only (the catalog prices completion at zero). build then full suite on the committed tree: 237 files / 3727 passed / 0 failed, tsc and eslint clean. OPEN ITEMS: the cap-of-0 refusal is pinned for BudgetTracker but not separately for checkEstimate; mutation proof: 4 of 4 guards caught (docs_dev/20261010-wave7-verify.md step 8).

## Out of scope

The result envelope field itself (L2-12), the `--estimate` flag (C4-08), browse status wiring (BR cards).
