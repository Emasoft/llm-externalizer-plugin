---
trdd-id: TYSKX72I
title: Split scripts/llm-ext/src/index.ts so the ubs taint analysis finishes on every part
column: backburner
status: tasked
created: 2026-11-17T22:41:08+0100
updated: 2026-11-17T22:48:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: refactor
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T22:41:08+0100
---

# Split scripts/llm-ext/src/index.ts so the ubs taint analysis finishes on every part

USER 2026-11-17 verbatim: 'why partial runs? we cannot risk to commit bugged code.' So the strict ubs pre-commit hook (TRDD-KZA573Q7) blocks a partial run. Measured 2026-11-17, one run: ubs 5.5.26 on index.ts (8572 lines) ran 26 s, 0 critical, then exited 2 because taint_js stopped at its work limit (Partial: ANALYZER_ERROR ... Taint dataflow work limit exceeded). The limit is fixed in ubs code (taint_js.py line 2995: work_limit = max(500_000, 128 * len(code))), no env var or config raises it. Consequence: every commit that stages index.ts is blocked by the hook. Goal: split index.ts into modules each of which ubs --staged scans without a partial run, with no behaviour change. Unknown and to measure first: whether the limit is exceeded because of file size or because of specific functions (the limit grows with code length, so size alone may not be the cause); scan halves or the largest functions to find out before splitting.

## Approval log

- 2026-11-17T22:41:08+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Constraints

Each split step must pass ubs --staged with no partial run and no critical finding before its commit; --no-verify is not allowed for this work.
Scope: only the 22 src .ts files over 60 KB were scanned, each alone; a staged combination of smaller files can still run partial (seen 2026-11-17 with ubs 5.4.17 elsewhere: two files timed out together while each passed alone).
