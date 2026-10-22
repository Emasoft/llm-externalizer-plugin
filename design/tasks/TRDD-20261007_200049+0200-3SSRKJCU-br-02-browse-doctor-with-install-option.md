---
trdd-id: 3SSRKJCU
title: BR-02 browse doctor with install option
column: backburner
status: tasked
created: 2026-10-07T20:00:49+0200
updated: 2026-10-07T20:00:52+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:49+0200
---

# BR-02 browse doctor with install option

## Goal

`browse doctor` always works and reports Playwright and browser state; `--install` installs a pinned version under an install lock.

## Approval log

- 2026-10-07T20:00:49+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (`browse doctor --install` pinned version, `withInstallLock`; `browse doctor` always works), E89, §2 Playwright ruling.

## Depends on

BR-01 (TRDD-RZPFS4SW)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

`withInstallLock` (named in plan §10); read the code at card start.

## Steps

1. Implement `browse doctor`: report Playwright presence and missing browsers; it works even when Playwright is missing.
2. Implement `--install` with a pinned version, under `withInstallLock`.
3. When browsers are missing, report them and the install command (E89).

## Acceptance

- [ ] pinned version
- [ ] install lock
- [ ] E89: Playwright present, browsers missing: `browse doctor` → reports the missing browsers and the install command
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The loader (BR-01), run-time gating (BR-03).
