---
trdd-id: GBWVXEF6
title: Merge the two SECRET_PATTERNS copies of intake.ts and scan-pipeline.ts into one module
column: todo
status: tasked
created: 2026-11-18T12:36:56+0100
updated: 2026-11-18T16:24:38+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T12:36:56+0100
---

# Merge the two SECRET_PATTERNS copies of intake.ts and scan-pipeline.ts into one module

security_scan/intake.ts and scan-pipeline.ts each hold a SECRET_PATTERNS list; they differ (intake.ts adds sk-, AIza, JWT, CONN_STRING, SECRET_ASSIGNMENT) and the PEM_BLOCK and ENV_SECRET lines must be kept byte-identical by hand (comment in intake.ts). Found by the main agent while fixing TRDD-G49XPDNI (commit b84e6dac). Done when one module exports the patterns, both callers import it, and their tests pass.

## Approval log

- 2026-11-18T12:36:56+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Progress

2026-11-18T12:50:08+0100 main agent (written by worker): scope widened: a third, smaller pattern list, written in Python, lives in scripts/diagnostics/dump-state.py: five regexes (sk-, hf_, sk-or-v1, Bearer, and one named-assignment pattern whose name list includes JWT_SECRET), no PEM-block or JWT token-shape pattern; its comment calls it an approximate mirror. Its assignment pattern still starts with the unbounded \s* that TRDD-G49XPDNI removed from the TypeScript copies. It cannot share a TypeScript module, so the card also decides how that copy is kept in step (generated from the one module, or checked by a test).

## Acceptance

- [x] one module exports the patterns and both callers import it: commit 7ff32943 creates scripts/llm-ext/src/secret-patterns.ts (SCAN_PIPELINE_SECRET_PATTERNS and INTAKE_SECRET_PATTERNS); grep finds secret-patterns referenced from security_scan/intake.ts and scan-pipeline.ts
- [ ] their tests pass (card Done when): not run in this session (tests are barred here); commit 7ff32943 message says no behaviour change, by a worker before/after dump of every pattern
- [x] the Python copy in scripts/diagnostics/dump-state.py no longer starts with the unbounded \s* that TRDD-G49XPDNI removed from the TypeScript copies: commit 273d8a29, dump-state.py line 42 now starts with ^[^\S\r\n]*; test tests/test_diagnostics.py test_dump_state_redact_keeps_blank_line_before_env_secret exists
- [x] decide how the dump-state.py copy is kept in step with the one module (generated from it, or checked by a test): its comments now point at secret-patterns.ts as a mirror, and the only test is the blank-line behaviour test; no parity check or generator found this run

## Notes

2026-11-18T16:24:37+0100 main agent ruling (delegated by USER 2026-11-18, "solve all issues yourself. i need results."; not an owner answer): dump-state.py is kept in step by hand, with neither a generator nor a parity test: it deliberately re-implements a smaller subset with no dependency on the TypeScript module (its module docstring says so), so a generated copy or an equality test would contradict that design; its comments name scripts/llm-ext/src/secret-patterns.ts as the source (273d8a29).
