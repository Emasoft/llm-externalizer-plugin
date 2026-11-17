---
trdd-id: 25KZDVYF
title: Triage the ubs 5.5.26 critical findings in 13 TypeScript files so commits that stage them pass the pre-commit hook
column: backburner
status: tasked
created: 2026-11-17T22:45:00+0100
updated: 2026-11-17T22:45:00+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T22:45:00+0100
---

# Triage the ubs 5.5.26 critical findings in 13 TypeScript files so commits that stage them pass the pre-commit hook

Measured 2026-11-17 (ubs 5.5.26, one direct-path run per file, every scripts/llm-ext/src .ts file over 60 KB): exit 1 (critical findings) on config.test.ts (67 critical), index.test.ts (24), broker/broker.test.ts (14), broker/server.ts (13), config.ts (6), provider/completion.ts (6), profile-chain-402.test.ts (6), benchmark/index.ts (4), benchmark/pick.ts (4), dynamic-maintainer.test.ts (3), dynamic-maintainer.ts (1), mass_scouting/mcp-tools.ts (1), benchmark/populate-default-profile.test.ts (1). Rule groups seen in the text report: js.security.hardcoded-secrets, javascript.ctcompare.unsafe_secret_compare, js.security.prototype-pollution (the text report shows only sample locations; get every location from ubs --format=json). The pre-commit hook (old and strict) blocks exit 1, so a commit staging any of these files is blocked; this matters for WPH1158N and other cards that edit those files. Smaller files were not scanned. Work: per file, read each flagged line; fix a real defect; mark a verified false positive with a trailing ubs:ignore comment plus the reason; never --no-verify. A prior observation (2026-11-04, another codebase) found most criticals in secret-handling code were false positives; that is a lead, not a rule: read each line. Done when ubs --staged on each file exits 0 or 1-free.

## Approval log

- 2026-11-17T22:45:00+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
