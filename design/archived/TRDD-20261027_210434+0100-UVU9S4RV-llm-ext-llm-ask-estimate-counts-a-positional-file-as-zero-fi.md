---
trdd-id: UVU9S4RV
title: llm-ext llm ask --estimate counts a positional file as zero files
column: complete
status: archived
created: 2026-10-27T21:04:34+0100
updated: 2026-10-31T05:28:35+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T21:04:34+0100
implementation-commits: [510b8edd]
---

# llm-ext llm ask --estimate counts a positional file as zero files

Observed 2026-10-27 on a temp config copy: `llm-ext llm ask <file> -o <dir> --instructions explain --estimate` printed "files: 0 total requests: 1" and "note: no input files — instructions/input_files_content-only chat". The real run of the same shape, without --estimate, does send the file: its answer described the file's function. So the estimate may undercount the input tokens of a positional file. Cause not investigated. Also open from TRDD-CQSODQ78: no permanent CLI-level test proves the --estimate branch refuses (main.ts runs main() at import, so only the exported profileGateRefusal is tested); the end-to-end proof was one manual run.

## Acceptance
- [x] the cause is found by reading the estimate path for llm ask
- [x] the estimate counts a positional file like the real run sends it, with a test

## Approval log

- 2026-10-27T21:04:34+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-31T05:28:35+0100 — COMPLETE by main-agent@llm-externalizer-plugin. archived as complete (from column backburner).

## Notes

2026-10-31: boxes 1-2 ticked on commit 510b8edd and src/cli/estimate-positional-cli.test.ts passing on 2026-10-31.
