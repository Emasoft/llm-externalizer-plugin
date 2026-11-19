---
trdd-id: 2N4JVQI8
title: IN-09 rank and find text output (--top, --all listing, chunk notes)
column: published
status: archived
created: 2026-10-10T08:23:45+0200
updated: 2026-11-19T10:39:37+0100
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
release-via: publish
---

# IN-09 rank and find text output (--top, --all listing, chunk notes)

## Goal

rank and find print their results as text: rank lists `relevance  id` lines and find lists `score  file:line  text` lines, with `(no matching lines)` when nothing matches and a chunk note when an item was judged in parts.

## Plan refs

Plan 283-284; qs:1054-1140; E129 (find line pieces).

## Depends on

- IN-07 (TRDD-LWDKZO2A), which provides the text output.

## Acceptance

- [x] rank text lines `relevance  id`
- [x] find text lines `score  file:line  text`, `(no matching lines)`
- [x] chunk note `(N chunks, best lines A-B)`
- [x] definition of done as stated in plan §16 (design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md): tests in the vitest include list, typecheck, lint and `npx eslint . --quiet` clean, full `npm test` green, no test doubles beyond the GlobalFetch seam, one commit with the TRDD id in its subject, WHY comments at non-obvious rules

## Approval log

- 2026-10-10T08:23:45+0200 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-10T08:28:29+0200 — column → backburner. depends on IN-07 (LWDKZO2A), which waits on open question Q4
- 2026-11-19T10:39:37+0100 — column → complete by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit
- 2026-11-19T10:39:37+0100 — PUBLISHED by main-agent@llm-externalizer-plugin. code shipped in v14.3.0 (c4dc6bd5), unchanged in v14.7.5; T6F52GB8 audit.

## Notes

2026-11-18T16:53:22+0100 72c0a3a0 (pre-squash, code in c4dc6bd5) also delivers IN-09 per the M8GT4AYB evidence; verify with its own tests before closing.
Evidence (verifier VA): rank.ts:85 relevance, id and (N chunks, best lines A-B); find.ts:111-116 score id:line text and (no matching lines); find has no chunk concept, the chunk note is met by rank and label.ts:119; rank 38, find 53, label 47 pass.
DoD by main agent checks on 2026-11-19 at HEAD 55269f3b: the cited test files are in the explicit vitest include list (grep) and contain no vi.mock, vi.spyOn, vi.fn or vi.stubGlobal (grep); npx tsc --noEmit and npx eslint . --quiet exit 0; full npm test inferred from the v14.7.5 release (commit f0766476 is the one scripts/publish.py makes at :1262 only after run_checks at :942 passes, and run_checks runs npm test at :403; no run log read, not rerun), and the cited source is unchanged between v14.7.5 and HEAD (git diff --stat empty); the per-card commit item cannot be met after the 14.3.0 squash c4dc6bd5, and WHY comments were spot-checked in estimate-output.ts only (a 2026-11-05 WHY-comment pass covered the runner and input code, its open items are in TRDD-HZMA4EXK); by main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer) the box is ticked with these two items accepted as stated, and the closing card commit names the id.
