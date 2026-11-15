---
trdd-id: B07E5M93
title: CLI stats file under /tmp/claude lacks the statusline symlink and owner guards
column: complete
status: archived
created: 2026-10-30T08:02:06+0100
updated: 2026-10-31T21:04:20+0100
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
- 2026-10-31T21:04:20+0100 — COMPLETE by main-agent@llm-externalizer-plugin. cab4307d; the foreign-uid refusal test exists and a mutation of the owner check fails it (07ba007a); ships in 14.3.0.

## Acceptance

- [x] writeStatsFile refuses a symlinked /tmp/claude (lstat before mkdir) - evidence: cab4307d, stats-file.ts:40-66; stats-file.test.ts
- [x] writeStatsFile opens the directory and temp file with no-follow - evidence: cab4307d, stats-file.ts:40-66 O_NOFOLLOW dir open and temp open; index.ts:1580 calls it
- [x] writeStatsFile refuses a directory not owned by the current user (fstat uid check) - evidence: cab4307d, stats-file.ts:40-66 (code read)
- [x] a test covers the foreign-uid refusal - MISSING: no such test exists (it needs a second uid); stats-file.test.ts has 3 tests, none for it
- 2026-10-31 proof pass 1, box 4 ticked: the test already exists, stats-file.test.ts "refuses a directory owned by another user (/usr is root-owned)" (4 tests in the file, committed in cab4307d; the card text said 3). It calls writeStatsJsonGuarded on /usr (root-owned, a non-root user can stat it) and asserts the throw matches /owned by uid/ and that no probe file or .tmp was created; it skips when the process uid is 0. Run: vitest run src/stats-file.test.ts exit 0, 4 of 4 pass. Mutation in an exported tree (stats-file.ts:55 owner !== uid replaced by false): exit 1, that test fails with got EPERM fchmod instead of the owner message, other 3 pass.
