---
trdd-id: 45XGJJ1M
title: BR-04 Session lifecycle and Ctrl-C
column: backburner
status: tasked
created: 2026-10-07T20:00:55+0200
updated: 2026-10-07T20:00:58+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:00:55+0200
---

# BR-04 Session lifecycle and Ctrl-C

## Goal

Own the browser session lifecycle so every exit path closes the browser, including Ctrl-C.

## Approval log

- 2026-10-07T20:00:55+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 (every status closes the browser in `finally`), D11 (Ctrl-C: abort run, close browser, remove temp record dir, emit `status:error, aborted: cancelled-by-caller`), E97, E100.

## Depends on

BR-01 (TRDD-RZPFS4SW), L2-18 (TRDD-WVG0VPZB)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

L2-18 abort handling (`l2/abort.ts`); read the code at card start.

## Steps

1. Open the session and close it in `finally` on every status.
2. On a browser crash, return status `error` with resources closed (E97).
3. On Ctrl-C: abort the run, close the browser, remove the temp record dir, emit `status:error, aborted: cancelled-by-caller` (D11).

## Acceptance

- [ ] E97: browser crashes mid-run → `error`; resources closed
- [ ] E100: Ctrl-C during browse → D11 cleanup
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Recording temp cleanup (BR-15), real-browser tests (BR-20).
