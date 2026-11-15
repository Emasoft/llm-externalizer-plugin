---
trdd-id: 41X8FKPI
title: Repeated --file_pairs marker entries flatten and the file_pairs schema contradicts its marker doc
column: backburner
status: tasked
created: 2026-11-14T03:07:08+0100
updated: 2026-11-14T03:07:08+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T03:07:08+0100
---

# Repeated --file_pairs marker entries flatten and the file_pairs schema contradicts its marker doc

Found during TRDD-OK1NN5RN (ff8b730c). (1) parseFlags merges repeated array occurrences one level deep, so a --file_pairs value given as a one-element marker entry list in one occurrence and repeated in another can end as a bare string instead of a one-element array (code reading, not run). llm-ext 14.2.0 kept only the last occurrence, so it is no worse than before. (2) scripts/llm-ext/src/tools/definitions.ts about lines 1233-1245: file_pairs items are arrays with minItems 2 and maxItems 2, while the description documents a one-element GROUP marker entry; whether the CLI enforces minItems was not checked. Acceptance: a test runs the built CLI with --file_pairs repeated including a marker entry and asserts the marker stays a one-element array, or the CLI refuses it with an error; the schema and its description agree.

## Approval log

- 2026-11-14T03:07:08+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
