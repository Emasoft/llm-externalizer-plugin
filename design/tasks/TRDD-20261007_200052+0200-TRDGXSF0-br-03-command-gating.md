---
trdd-id: TRDGXSF0
title: BR-03 Command gating
column: backburner
status: tasked
created: 2026-10-07T20:00:52+0200
updated: 2026-10-07T20:00:55+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:52+0200
---

# BR-03 Command gating

## Goal

Gate `browse run` so that without a working Playwright it exits non-zero with the install message.

## Approval log

- 2026-10-07T20:00:52+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (missing Playwright: `browse run` exits non-zero with "Playwright is not installed — run `llm-ext browse doctor --install`"; `browse doctor` always works), §2 Playwright ruling, E88, E89b.

## Depends on

BR-01 (TRDD-RZPFS4SW)

## Files

Under `scripts/llm-ext/src/browser/` and the command wiring (exact list at card start).

## Reuse

BR-01 loader; read the code at card start.

## Steps

1. Before any browser work, call the BR-01 loader from `browse run`.
2. If Playwright is missing, exit non-zero with "Playwright is not installed — run `llm-ext browse doctor --install`".
3. If browsers are missing, fail naming `browse doctor --install`.
4. Leave `browse doctor` ungated.

## Acceptance

- [ ] E88: Playwright missing → `browse run/page` exit with install message
- [ ] E89b: Playwright present, browsers missing: `browse run` → fails naming `browse doctor --install`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The doctor command (BR-02), the loader (BR-01).
