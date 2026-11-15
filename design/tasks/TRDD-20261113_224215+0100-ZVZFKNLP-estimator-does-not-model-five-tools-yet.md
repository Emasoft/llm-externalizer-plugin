---
trdd-id: ZVZFKNLP
title: Estimator does not model five tools yet
column: backburner
status: tasked
created: 2026-11-13T22:42:15+0100
updated: 2026-11-13T23:05:32+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-13T22:42:15+0100
---

# Estimator does not model five tools yet

Measured 2026-11-13 on HEAD b9bf1f26 (same report). --estimate refuses with "--estimate does not model '<tool>' yet" for session_summary (session compact), check_tool_replacements (models replacements), batch_check, security_triage_benchmark, search_existing_benchmark. Decide per tool: model it in the estimator, or record it as a permanent design refusal. Either way update the dry-run support table DRY_RUN_SUPPORT from TRDD-58CFBQHN step 2 (scripts/llm-ext/src/cli/dry-run-flags.ts). batch_check is deprecated; dropping it may be the right answer. Acceptance: each tool either estimates on a minimal valid input with no model request, or carries a recorded design reason in the table.

## Approval log

- 2026-11-13T22:42:15+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Related

Found by TRDD-58CFBQHN step 2: its dry-run support table marks these tools as gaps pointing here; fixing this card must update that table (its binding test fails until it does).
batch_check --preview is accepted (measured on the built CLI with a real input_files_paths file); only its --estimate is this gap.

## Measurement environment

Measured with env -i, a fake OPENROUTER_API_KEY and a paid scratch profile, because with no key the free-profile gate refuses --estimate for every command; a reproduction without a key sees every --estimate refused and must not read that as this gap.
