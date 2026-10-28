---
trdd-id: GRCE2QUQ
title: backupSettingsFile must never overwrite an existing backup
column: todo
status: tasked
created: 2026-10-28T14:08:41+0100
updated: 2026-10-28T14:08:41+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-28T14:08:41+0100
---

# backupSettingsFile must never overwrite an existing backup

Backup names have one-second resolution and the write is a plain writeFileSync, so a same-second backup can replace another (pick.ts backupSettingsFile, around lines 1011-1034); use the wx flag or a unique suffix.
Also the config.ts comment near line 1893 says no placeholder passes validateProfile, but only free does (paid only without a key). Found while fixing TRDD-5Q79QZM7.

## Approval log

- 2026-10-28T14:08:41+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
