---
trdd-id: NX50C2VF
title: The profile maintainer import chain loads the typescript compiler
column: backburner
status: tasked
created: 2026-11-15T18:38:46+0100
updated: 2026-11-15T18:38:46+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T18:38:46+0100
---

# The profile maintainer import chain loads the typescript compiler

Found 2026-11-15 by the 14.3.0 publish dry run (test fix be753a18). Since f77113d9 (TRDD-SZ7TO9FW inc 3) benchmark/validated.ts imports backfill-ledgers.ts, so dynamic-maintainer.ts reaches benchmark/security-triage/index -> validated -> backfill-ledgers -> code-task/index -> code-task/dataset.ts, which imports typescript. The shipped dist is one bundle with a __filename banner, so nothing breaks, but any CLI path that loads the maintainer may now evaluate the whole typescript compiler at startup. f77113d9's message names a ledger backfill purpose and never mentions typescript, so this looks incidental (inference). To do: measure CLI startup time and memory with and without that chain; if the cost is real, make the typescript import lazy (dynamic import inside dataset.ts) or cut the backfill-ledgers -> code-task import; add a test that the maintainer path does not load typescript.

## Approval log

- 2026-11-15T18:38:46+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
