---
trdd-id: JGJ948C8
title: SEC-01 Licence audit of every distilled source
column: complete
status: archived
created: 2026-10-07T20:29:39+0200
updated: 2026-10-07T22:24:44+0200
current-owner: user
created-by: user
task-type: audit
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:29:39+0200
---

# SEC-01 Licence audit of every distilled source

## Goal
Audit the licence of every distilled source and decide what text may be reused.

## Approval log

- 2026-10-07T20:29:39+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-07T22:24:44+0200 — COMPLETE by main-agent@llm-externalizer-plugin. archived → complete.

## Plan refs

§1 D17, D28, §2b (source table), §16 (SEC table).

## Depends on

none

## Files

- Report under `reports/` (path to be listed at card start); NOTICE entries are owned by the cards that copy text.

## Reuse

Read the code at card start; §2b lists the sources.

## Steps

1. For each §2b source, record the licence found (D17).
Record, for each source repository, the commit hash audited; the spec and browse cards read their cited source lines at that commit.
2. Note quicksilver: the repo is MIT, the locally installed 0.3.0 additions carry no licence file (D28).
3. Note OpenRouterTeam/skills: no licence declared, so text is rewritten (§2b).
4. Produce the reuse list: copy only where the licence allows, with a NOTICE entry; otherwise rewrite in our own words (D17).

## Acceptance

- [x] table of licences; reuse list
- [x] each source's audited commit hash recorded in the report and on this card
- [x] definition of done for an audit card: report under reports/ with every source, licence, commit and reuse decision; the result recorded on the card; no code changed

## Out of scope

Reviewing copied code blocks (SEC-07); writing NOTICE entries.

## Result (2026-10-07)

- jkudish/jev-mcp: MIT, 86eae78, may copy with NOTICE entry
- jkudish/jev-browser: MIT, e04be30, may copy with NOTICE entry
- OpenRouter decisions API reference, typesafe-sdk page, jev guide, jev-tutorial, jev-classification cookbook: documentation, no code licence, no commit (web pages), facts only, rewrite in our own words
- jev-router: nothing built, no reuse
- OpenRouterTeam/typescript-sdk: Apache-2.0, d2d0872, wire types as cross-check; copy only with NOTICE entry, default rewrite
- OpenRouterTeam/skills: none declared, 33597a4, rewrite in our own words
- OpenRouterTeam/typescript-agent: repo none declared (packages Apache-2.0), e309ebf, nothing taken
- buchmark/claude-jev: MIT, 06fe407, may copy with NOTICE entry
- MorenoLand/Moreno.Jev: MIT, 3034cc5, may copy with NOTICE entry
- Pleo2/awesome-jev-agent-skills: MIT, 42e3d17, may copy with NOTICE entry
- NiazMorshed2007/jev-review: MIT, 57690af, nothing built, no reuse
- UditAkhourii/quicksilver repo 0.2.0: MIT, 5d6fe5c, repo text may be copied with full MIT notice in NOTICE
- quicksilver 0.3.0 local install: no licence file, authorship undetermined, re-implement behaviour in our own words (D28)
- Report: llm-externalizer-plugin/reports/jev-classifiers/20261007_222300+0200-sec-01-licence-audit.md
