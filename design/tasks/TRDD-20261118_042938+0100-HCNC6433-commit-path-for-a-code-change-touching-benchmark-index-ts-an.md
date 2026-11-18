---
trdd-id: HCNC6433
title: Commit path for a code change touching benchmark/index.ts and benchmark/pick.ts through the ubs hook
column: backburner
status: tasked
created: 2026-11-18T04:29:38+0100
updated: 2026-11-18T04:29:38+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T04:29:38+0100
---

# Commit path for a code change touching benchmark/index.ts and benchmark/pick.ts through the ubs hook

Split out of TRDD-25KZDVYF (its decision D1). Staged together, benchmark/index.ts and benchmark/pick.ts form one ubs taint component that exceeds the analysis work limit, so the pre-commit hook gets a partial run and blocks the commit (measured on 2026-11-17). Comment-only changes were committed apart (4ddb3491, 5657606b). A CODE change that touches both files has no fully scanned commit path yet. USER decision: may a commit be split by ubs taint component when a staged set exceeds the work limit, or is the path a structural refactor such as TRDD-TYSKX72I? Until the USER answers, no code commit is split.

## Approval log

- 2026-11-18T04:29:38+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
