---
trdd-id: B5BN44I8
title: Shipped root .mjs files are outside the lint gate
column: dev
status: tasked
created: 2026-11-19T04:31:39+0100
updated: 2026-11-19T06:18:29+0100
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
implementation-commits: [576bc5cf]
---

# Shipped root .mjs files are outside the lint gate

scripts/llm-ext/eslint.config.mjs ignores every root *.js, *.mjs and *.cjs file, and the lint script is eslint src --max-warnings 0, so shipped root files such as scripts/llm-ext/install-lock.mjs are never linted. A repo-wide eslint run on 2026-11-19 found a preserve-caught-error hit in install-lock.mjs (fixed in c698c9ee). The config gives a reason only for the benchmark-fixtures ignore, not for the root *.mjs one. Decide: list the shipped root .mjs files and lint them (remove them from the ignore or add them to the lint script), or record why they stay outside the gate. Size S.

## Approval log

- 2026-11-19T04:31:39+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T06:15:50+0100 — column → dev. landed in 576bc5cf (main agent)

## Notes

2026-11-19T06:18:29+0100 main agent: done in 576bc5cf. The lint script is now eslint . --max-warnings 0 and the root *.js, *.mjs and *.cjs ignores are gone; reports/** and reports_dev/** are ignored instead. npm run lint exits 0 over 688 files with 0 errors and 0 warnings (main agent); the files outside src/ it lints are the six root files (data-dir.d.mts, data-dir.mjs, esbuild.config.mjs, eslint.config.mjs, install-lock.mjs, launcher.mjs), scripts/gen_cluster_fixtures.mjs, scripts/smoke_cluster_openrouter.ts and the two vitest configs, which are the tracked lintable files outside src/, dist/ and benchmark-fixtures/ (checked in this worktree only). publish.py sets mcp_dir to scripts/llm-ext (:356) and runs npm run lint there (:394), so the publish gate uses the new scope (the 576bc5cf message cites only :356). No source change was needed. UBS on 576bc5cf: 2 files scanned, 0 critical, 0 warnings. Residual: any untracked .ts, .js or .mjs file in the publishing checkout's scripts/llm-ext outside reports/ and reports_dev/ is now linted and can fail the publish gate; before running publish.py, check git status --porcelain --ignored scripts/llm-ext in that checkout.
