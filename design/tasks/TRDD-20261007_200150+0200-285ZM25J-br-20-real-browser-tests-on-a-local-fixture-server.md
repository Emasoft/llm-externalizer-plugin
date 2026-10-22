---
trdd-id: 285ZM25J
title: BR-20 Real-browser tests on a local fixture server
column: backburner
status: tasked
created: 2026-10-07T20:01:50+0200
updated: 2026-10-07T20:01:53+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:01:50+0200
---

# BR-20 Real-browser tests on a local fixture server

## Goal

Test the browse commands in a real headless browser against a local fixture server.

## Approval log

- 2026-10-07T20:01:50+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§12 E106 (origin mismatch and the origin re-check after a redirect run in a real browser), §16 testing rule (real tests, no doubles).

## Depends on

BR-08 (TRDD-5D4X8KFN), BR-14 (TRDD-WTAFTRR1)

## Files

To be listed at card start (fixture server, test file, vitest include entry).

## Reuse

Read the code at card start.

## Steps

1. Start a local fixture server and run the browse commands against it (derived from done-when).
2. Run pages in parallel and close every resource in `finally` (derived from done-when).
3. Run the password origin mismatch (E106) and the origin re-check after a redirect in the real browser.

## Acceptance

- [ ] headless, parallel, all resources closed
- [ ] password origin mismatch (E106) and the origin re-check after a redirect run in a real browser
- [ ] headless, parallel, every page, context and process closed in finally; screenshots in light and dark themes under reports/screenshots/
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

The password logic (BR-14), CI (BR-21).
