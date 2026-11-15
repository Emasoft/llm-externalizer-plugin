---
trdd-id: JAIAF96C
title: chainModelIds and high_quality_model under forced free mode (OE27RD7I row 79 residual)
column: backburner
status: tasked
created: 2026-10-31T17:17:08+0100
updated: 2026-10-31T17:17:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-31T17:17:08+0100
---

# chainModelIds and high_quality_model under forced free mode (OE27RD7I row 79 residual)

Row 79: chainModelIds re-derives resolveProfile's static free_only rule instead of reading resolveProfile's own resolved surfaces (desync risk on the next rule change); same gap for high_quality_model.id. Fix: derive the chain from resolveProfile's output, or gate high-quality-scan like tool_models, with pinning tests.

Parent: TRDD-OE27RD7I

## Approval log

- 2026-10-31T17:17:08+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
