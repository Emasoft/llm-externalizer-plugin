---
trdd-id: O248EWGS
title: BR-26 Final page formats, --max-chars, screenshot
column: backburner
status: tasked
created: 2026-10-07T20:02:15+0200
updated: 2026-10-07T20:02:18+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:02:15+0200
---

# BR-26 Final page formats, --max-chars, screenshot

## Goal

Output the final page in the chosen format with `--max-chars`, plus a final screenshot.

## Approval log

- 2026-10-07T20:02:15+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§10 Output (final page in `text|markdown|html|aria` with `--max-chars`; final JPEG screenshot, suppressed after any credential use; `--record`, `--headed` for debugging only).

## Depends on

BR-06 (TRDD-OZ0EX1CN)

## Files

Under `scripts/llm-ext/src/browser/` (exact list at card start).

## Reuse

Read the code at card start.

## Steps

1. Read the cited section of the jev-browser inventory report and the source lines it cites, in a clone of the jev-browser repository at the commit SEC-01 records; if no copy is present, clone it at that commit.
2. Render the final page as text, markdown, html or aria.
3. Apply `--max-chars` and report any truncation.
4. Take the final JPEG screenshot unless suppressed after credential use.

## Acceptance

- [ ] text/markdown/html/aria
- [ ] truncation reported
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Envelope and `-o` (BR-18), credentials suppression rules (BR-24).
