---
trdd-id: HUBGO80N
title: Non-classify dry-run headers say nothing was sent while the dry run may fetch pricing
column: backburner
status: tasked
created: 2026-11-19T05:48:27+0100
updated: 2026-11-19T05:48:27+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T05:48:27+0100
---

# Non-classify dry-run headers say nothing was sent while the dry run may fetch pricing

Found while landing TRDD-Z8LRK2DZ (16426995, main agent 2026-11-19). Two dry-run headers outside classify still print "nothing was sent": estimate.ts:484 "ESTIMATE (dry-run — nothing was sent) — <tool>" and cli/main.ts:977 "PREVIEW (dry-run — nothing was sent) — <tool>". The --estimate branch of cli/main.ts awaits warmEstimatePricing() before it prints the estimate, so that header may claim no network while a pricing fetch runs; the --preview path is not checked. Before rewording, measure on the built CLI which of the two fetches anything (temp HOME and LLM_EXT_CONFIG_DIR, LLM_EXT_INSTALL_RULE=0, HTTPS_PROXY pointed at a closed port, a free or local profile, never a paid one), then say exactly what is not sent (no model request), and update the tests that assert the header and the docs that quote it (grep "nothing was sent" over skills/ and README.md). Related: TRDD-Z8LRK2DZ. Size S.

## Approval log

- 2026-11-19T05:48:27+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
