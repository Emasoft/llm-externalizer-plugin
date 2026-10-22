---
trdd-id: LK79AHV4
title: SEC-07 No unreviewed corpus code copied
column: backburner
status: tasked
created: 2026-10-07T20:30:18+0200
updated: 2026-10-07T22:27:40+0200
current-owner: user
created-by: user
task-type: audit
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-07T20:30:18+0200
---

# SEC-07 No unreviewed corpus code copied

## Goal
Confirm no unreviewed corpus code was copied into the repo.

## Approval log

- 2026-10-07T20:30:18+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Plan refs

§16 (SEC table; npt SEC-01), D17.

## Depends on

SEC-01 (TRDD-JGJ948C8)

## Files

- Report under `reports/` (path to be listed at card start).

## Reuse

Read the code at card start; the SEC-01 reuse list.
From SEC-01 (TRDD-JGJ948C8): rewrite-only sources, no text or code may be copied: OpenRouterTeam/skills (no licence declared), every OpenRouter and TypeSafe documentation page, the locally installed quicksilver 0.3.0 additions. OpenRouterTeam/typescript-agent has no root licence although its packages declare Apache-2.0; nothing was taken from it, re-check before taking anything. claude-jev: licence granted by the repository owner while plugin.json names a different author; treat copies from it with care.

## Steps

1. Find every block copied from a distilled source (derived from done-when).
2. Review each block and note it with its source and licence (done-when).

## Acceptance

- [ ] every copied block reviewed and noted
- [ ] definition of done for an audit card: report under reports/ with every source, licence, commit and reuse decision; the result recorded on the card; no code changed

## Out of scope

The licence audit (SEC-01).
