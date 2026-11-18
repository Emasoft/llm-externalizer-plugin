---
trdd-id: 5SGTYL11
title: ubs taint analysis ends partial when config.ts and index.ts are staged together
column: backburner
status: tasked
created: 2026-11-18T15:21:30+0100
updated: 2026-11-18T15:21:30+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T15:21:30+0100
---

# ubs taint analysis ends partial when config.ts and index.ts are staged together

Measured 2026-11-18 14:55 (TN8OUZ50 commit, ubs 5.5.26): staging scripts/llm-ext/src/config.ts, index.ts and tools/discover.ts together ends partial: JavaScript taint analysis incomplete in one component (config.ts, index.ts), work limit max(500000, 128 x code length) in taint_js.py:2995, no setting raises it. Each file staged alone passes (fe0925b5, c8cbefdd). Consequence: a change that must touch both files is committed in two commits, which skips the cross-file taint analysis between the two files for that change. Fix direction: split config.ts (about 4700 lines) or move more of index.ts so the joined component fits, as TRDD-TYSKX72I did for index.ts alone. Done when: one commit that stages config.ts and index.ts together passes the hook with no Partial line.

## Approval log

- 2026-11-18T15:21:30+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
