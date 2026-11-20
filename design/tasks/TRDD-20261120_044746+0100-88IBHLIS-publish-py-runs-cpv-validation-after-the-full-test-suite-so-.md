---
trdd-id: 88IBHLIS
title: publish.py runs CPV validation after the full test suite, so a CPV-only failure costs a whole suite run
column: todo
status: tasked
created: 2026-11-20T04:47:46+0100
updated: 2026-11-20T04:58:40+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T04:47:46+0100
---

# publish.py runs CPV validation after the full test suite, so a CPV-only failure costs a whole suite run

scripts/publish.py calls run_cpv_validation (defined at publish.py:630; the abort message is at publish.py:999) only after npm test, ruff, mypy, shellcheck and pytest. CPV stopped a publish after a green test suite at least three times (14.7.3, 14.7.6, 14.7.8), each time after a full test-suite run (its duration was not measured). Run the CPV validation right after the build step and before npm test, so a CPV failure stops the publish in minutes. Keep the gate as strict as now (the same classify_cpv_findings logic), and first check that CPV needs nothing the test stages produce.

## Approval log

- 2026-11-20T04:47:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-20T04:58:38+0100 main agent (written by worker): second part of this card. Add a publish.py pre-flight check, run before npm ci, that fails at once when the plugin tree holds a reports/ folder with any file, tracked or untracked, while CPV issue 275 (Emasoft/claude-plugins-validation) is open. CPV raises '[MAJOR] .gitignore missing coverage for: Agent/script reports (reports/)' for such a folder, and that finding stopped the 14.7.3, 14.7.6 and 14.7.8 publishes only after a green test suite. Remove the check when issue 275 is fixed.
