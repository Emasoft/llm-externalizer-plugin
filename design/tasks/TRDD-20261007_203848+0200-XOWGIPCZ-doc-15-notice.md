---
trdd-id: XOWGIPCZ
title: DOC-15 NOTICE
column: backburner
status: tasked
created: 2026-10-07T20:38:48+0200
updated: 2026-11-19T11:21:40+0100
current-owner: user
created-by: user
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:38:48+0200
---

# DOC-15 NOTICE

## Goal
Append the classifier sources' attribution entries to RD-01's NOTICE file.

## Approval log

- 2026-10-07T20:38:48+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

design/plans/20261007_171500+0200-classifiers-profile-types-readme-plan-ZB41KG62.md §13 Documentation plan (row DOC-15); §16 card template and definition of done; §17; D17, D28

## Depends on

SEC-01 (TRDD-JGJ948C8), RD-01 (TRDD-ZIZ01KCA)

## Files

RD-01's NOTICE file (appended).

## Reuse

read the code at card start
From SEC-01 (TRDD-JGJ948C8): sources that may be copied only with a NOTICE entry, with licence, copyright holder and audited short hash: jkudish/jev-mcp, MIT, (c) 2026 Joey Kudish, 86eae78; jkudish/jev-browser, MIT, (c) 2026 Joey Kudish, e04be30; buchmark/claude-jev, MIT, (c) 2026 buchmark, 06fe407; MorenoLand/Moreno.Jev, MIT, (c) 2026 Moreno.Jev contributors, 3034cc5; Pleo2/awesome-jev-agent-skills, MIT, (c) 2026 Pleo2, 42e3d17; UditAkhourii/quicksilver repo v0.2.0 only, MIT, (c) 2026 Udit Akhouri, 5d6fe5c (full MIT notice); OpenRouterTeam/typescript-sdk, Apache-2.0, copyright holder not recorded in the audit (take it from LICENSE.md at d2d0872 before copying), keep copyright and state changes, default is rewrite. Provenance note: claude-jev's plugin.json names author 'oxdev' while the repository owner is buchmark.

## Steps

1. Append the entries for the classifier sources, using SEC-01's licence results (D17, D28); copy only text whose licence allows it, with the full MIT notice for quicksilver repo text.

## Acceptance

- [ ] (derived from title) NOTICE carries an entry for every classifier source whose text is reused
- [ ] definition of done for a docs card: CPV clean on any skill touched; the README-vs-CLI test (RD-15/DOC-13) green when a flag table or the README is touched; one commit with the TRDD id in its subject; no code changed

## Out of scope

The licence audit itself (SEC-01).

## Notes

T6F52GB8 audit 2026-11-19 (verifier VB, not re-read by the main agent): PARTLY. Done: NOTICE has quicksilver and claude-jev entries; headers of extract.ts:2, compare.ts:2, review.ts:1, audit.ts:1, findings.ts:1 say the question wording is own. Remaining: Pleo2 entry if the preset labels are copied (classifiers/catalog/check.ts:1 says they come from it); jev-mcp and Moreno entries only if text is copied (the fixed reason-code vocabulary in review.ts is open); needs a one-line judge decision.
2026-11-19T11:11:32+0100 R3 of the T6F52GB8 final report (main agent ruling, delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): NOTICE entry added for Pleo2/awesome-jev-agent-skills (MIT, Copyright (c) 2026 Pleo2); no jev-mcp or Moreno entry, because those file headers say the wording is our own.
2026-11-19T11:21:39+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): box 1 unticked again: whether review.ts copies the jev-mcp reason-code vocabulary is unknown (the jev-mcp source is not on disk), so NOTICE cannot yet be shown to cover every reused source; it is re-ticked when that comparison is done.
