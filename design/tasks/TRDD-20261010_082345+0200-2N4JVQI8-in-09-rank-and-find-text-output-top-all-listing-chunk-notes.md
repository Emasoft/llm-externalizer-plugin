---
trdd-id: 2N4JVQI8
title: IN-09 rank and find text output (--top, --all listing, chunk notes)
column: backburner
status: tasked
created: 2026-10-10T08:23:45+0200
updated: 2026-10-10T08:28:29+0200
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-10T08:23:45+0200
---

# IN-09 rank and find text output (--top, --all listing, chunk notes)

## Goal

rank and find print their results as text: rank lists `relevance  id` lines and find lists `score  file:line  text` lines, with `(no matching lines)` when nothing matches and a chunk note when an item was judged in parts.

## Plan refs

Plan 283-284; qs:1054-1140; E129 (find line pieces).

## Depends on

- IN-07 (TRDD-LWDKZO2A), which provides the text output.

## Acceptance

- [ ] rank text lines `relevance  id`
- [ ] find text lines `score  file:line  text`, `(no matching lines)`
- [ ] chunk note `(N chunks, best lines A-B)`
- [ ] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:23:45+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:28:29+0200 — column → backburner. depends on IN-07 (LWDKZO2A), which waits on open question Q4
