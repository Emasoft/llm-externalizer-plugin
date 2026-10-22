---
trdd-id: RZPFS4SW
title: BR-01 Optional Playwright loader
column: backburner
status: tasked
created: 2026-10-07T20:00:46+0200
updated: 2026-10-07T20:00:49+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:46+0200
---

# BR-01 Optional Playwright loader

## Goal

Load Playwright only when present, from the data dir, so the browse commands are optional.

## Approval log

- 2026-10-07T20:00:46+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§2 Playwright ruling: "the playwright dependency must be optional. in the sense that if the user machine has no playwright installed and working, then the commands using the browser will not be enabled, and will return a error saying to install playwright before using them." §10 (Playwright loader: `createRequire(<data-dir prefix>)`, `LLM_EXT_PLAYWRIGHT_DIR` override; Playwright imported only in `browser/`), §3.

## Depends on

none

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Load Playwright with `createRequire` from the data-dir prefix.
2. Honour the `LLM_EXT_PLAYWRIGHT_DIR` override.
3. Keep every Playwright import inside `browser/`; the main bundle never imports it (derived from §3).
4. When Playwright is missing, report that state for BR-02 and BR-03 to use (derived from done-when).

## Acceptance

- [ ] `createRequire` from data dir
- [ ] `LLM_EXT_PLAYWRIGHT_DIR`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The doctor command (BR-02), command gating (BR-03), cross-platform paths (BR-22).
