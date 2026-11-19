---
trdd-id: MAWCGDTH
title: SWNIIFTF lists prerequisites its own note says are no longer needed
column: todo
status: tasked
created: 2026-11-19T11:57:37+0100
updated: 2026-11-19T11:57:37+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T11:57:37+0100
---

# SWNIIFTF lists prerequisites its own note says are no longer needed

Archived TRDD-SWNIIFTF (column complete) keeps npt [1OOAH3LD, ZGSGGHQG], while its own note of 2026-11-14 says the broker cards "are no longer needed for this box" (box (c) was proven on the real governor queue in 164fa021). trddgrep validate therefore reports ERROR ORDER-NPT-VIOLATED on it. The terminal-freeze rule lets a complete card change only updated and superseded-by, so the stale npt cannot simply be cleared. Decide an allowed repair for a stale npt on a terminal card (a trddgrep fix rule, or a USER ruling), apply it to SWNIIFTF, and re-run validate.

## Approval log

- 2026-11-19T11:57:37+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
