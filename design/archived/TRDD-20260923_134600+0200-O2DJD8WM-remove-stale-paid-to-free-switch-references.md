---
trdd-id: O2DJD8WM
title: Remove stale paid-to-free switch references
column: complete
created: 2026-09-23T13:46:00+0200
updated: 2026-10-05T07:46:53+0200
current-owner: agent
created-by: user
task-type: docs
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: agent
approval-datetime: 2026-09-23T13:46:00+0200
status: archived
---

# Remove stale paid-to-free switch references

## What
- src/model-reconcile.ts:16-17 (in scripts/llm-ext) still describes 'the credit-driven paid to free switch', which TRDD-OE27RD7I addendum 4 deleted. Rewrite the comment to match current behaviour: detection only, no switch.
- TRDD-542BDBEF ('Auto-engage free mode when OpenRouter balance drops below $1') is in column complete, but its behaviour was reversed by TRDD-OE27RD7I addendum 4. Terminal cards are frozen, so do not edit its body; leave a dated note in TRDD-OE27RD7I (the live card) saying it reverses TRDD-542BDBEF; do not edit TRDD-542BDBEF (terminal cards are frozen).

## Why
Found by the code map for TRDD-YG72CYY7 (2026-09-23). Stale comments make a future agent re-implement a feature the USER removed.

## Approval log

- 2026-09-23T13:46:00+0200 — MANDATE issued by agent (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-05T07:46:53+0200 — COMPLETE by main-agent@llm-externalizer-plugin. Both items verified on disk 2026-10-05; checklist ticked, card was in todo as bookkeeping only.

## Acceptance

- [x] model-reconcile.ts header comment rewritten: 'Detection only: ... no paid-to-free switch, no borrow' (verified on disk 2026-10-05)
- [x] dated reversal note on OE27RD7I (line 87): addendum-4 REVERSES TRDD-542BDBEF; 542BDBEF left unedited (terminal/frozen)
