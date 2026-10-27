---
trdd-id: WXR5LZ9Z
title: Next release carries the rank-0 exception into CHANGELOG and reviews the Dependabot alerts
column: todo
status: tasked
created: 2026-10-27T21:25:14+0100
updated: 2026-10-27T21:30:58+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: docs
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T21:25:14+0100
---

# Next release carries the rank-0 exception into CHANGELOG and reviews the Dependabot alerts

The v14.1.2 GitHub release notes were edited after publishing to add "except where a profile update is started" to the refusal sentence; the repo CHANGELOG.md 14.1.2 entry lacks that phrase. The next release must add it so the two agree. Also: on 2026-10-27 GitHub reported 84 Dependabot alerts on the default branch (2 critical, 23 high, 54 moderate, 5 low) and a dependabot branch is open on the remote; they were not reviewed during the 14.1.2 release.

## Acceptance
- [ ] CHANGELOG.md 14.1.2 entry matches the published release notes
- [ ] (moved) the Dependabot triage is tracked on its own security card

## Approval log

- 2026-10-27T21:25:14+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Risk until every session restarts

- 2026-10-27: sessions started before the 14.1.2 install still run 14.1.1 (the wrapper execs the plugin bin dir already on the session's PATH). A 14.1.1 free-profile re-test that passes only one model writes an invalid one-model ensemble again and breaks every llm-ext command for every session. Today's profile holds 2 free models (valid). If the error 'needs at least 2 ensemble members' returns, set the free section to mode: remote and restart the sessions.
