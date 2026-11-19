---
trdd-id: B5BN44I8
title: Shipped root .mjs files are outside the lint gate
column: backburner
status: tasked
created: 2026-11-19T04:31:39+0100
updated: 2026-11-19T04:31:39+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: infra
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:31:39+0100
---

# Shipped root .mjs files are outside the lint gate

scripts/llm-ext/eslint.config.mjs ignores every root *.js, *.mjs and *.cjs file, and the lint script is eslint src --max-warnings 0, so shipped root files such as scripts/llm-ext/install-lock.mjs are never linted. A repo-wide eslint run on 2026-11-19 found a preserve-caught-error hit in install-lock.mjs (fixed in c698c9ee). The config gives a reason only for the benchmark-fixtures ignore, not for the root *.mjs one. Decide: list the shipped root .mjs files and lint them (remove them from the ignore or add them to the lint script), or record why they stay outside the gate. Size S.

## Approval log

- 2026-11-19T04:31:39+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
