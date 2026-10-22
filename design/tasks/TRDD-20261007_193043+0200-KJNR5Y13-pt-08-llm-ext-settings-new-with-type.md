---
trdd-id: KJNR5Y13
title: PT-08 llm-ext settings new with --type
column: backburner
status: tasked
created: 2026-10-07T19:30:43+0200
updated: 2026-10-07T19:30:51+0200
current-owner: user
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T19:30:43+0200
---

# PT-08 llm-ext settings new with --type

## Goal
Add `llm-ext settings new <name> --type <type>`, which copies the type's template under the new name through the locked writer.

## Approval log

- 2026-10-07T19:30:43+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§8 (custom profiles); E81f.

## Depends on

PT-01 (TRDD-QRF04JVJ)

## Files

- `scripts/llm-ext/src/config.ts` (templates, writer)
- the settings command module: to be listed at card start
- tests and the vitest include entry: to be listed at card start

## Reuse

- the locked writer: read the code at card start
- the five templates and the field table (PT-01)

## Steps

1. Add `settings new <name> --type <type>`.
2. Copy that type's template into `settings.yaml` under the new name through the locked writer.
3. Refuse a name that already exists.
4. (derived from done-when) Register the command's `acceptedProfileTypes` row as `settings *` any type (§8).
5. Add WHY comments.

## Acceptance

- [ ] copies the type's template under the new name through the locked writer
- [ ] refuses an existing name
- [ ] E81f: `settings new x --type scouting` → copies the `scouting` template under `x`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Out of scope

Classifier-profile settings commands (PF-06).
