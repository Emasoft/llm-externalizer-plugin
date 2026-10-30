---
trdd-id: B07E5M93
title: CLI stats file under /tmp/claude lacks the statusline symlink and owner guards
column: backburner
status: tasked
created: 2026-10-30T08:02:06+0100
updated: 2026-10-30T08:02:06+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-30T08:02:06+0100
---

# CLI stats file under /tmp/claude lacks the statusline symlink and owner guards

The CLI writes its statusline stats file under /tmp/claude (scripts/llm-ext/src/index.ts, writeStatsFile: mkdirSync with mode 0o700, then a temp-file write and rename) with no lstat, no O_NOFOLLOW and no owner (uid) check. The statusline (scripts/statusline/statusline.py) opens the same directory with all three guards. On a shared host, a second local user who creates /tmp/claude first owns it: the CLI still writes its stats into it, and the statusline then refuses the directory, so the CLI row of the status bar goes empty with no error. The fix belongs on the CLI side: give writeStatsFile the same guards as the statusline (refuse a symlink, refuse a directory not owned by the current user, open with no-follow) and fail silently as today, since the stats file must never break a command. Moved here from PUBLISH_NOTES.md (14.2.0 docs pass), where it was listed as a known follow-up.

## Approval log

- 2026-10-30T08:02:06+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
