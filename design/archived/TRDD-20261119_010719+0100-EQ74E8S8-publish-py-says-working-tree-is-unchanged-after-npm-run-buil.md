---
trdd-id: EQ74E8S8
title: publish.py says Working tree is unchanged after npm run build rewrote the tracked dist files
column: superseded
status: archived
created: 2026-11-19T01:07:19+0100
updated: 2026-11-19T20:40:51+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T01:07:19+0100
superseded-by: [EWU9OAYI]
---

# publish.py says Working tree is unchanged after npm run build rewrote the tracked dist files

Found by the main agent during the 14.7.3 publish runs, verified by reading the code 2026-11-19. scripts/publish.py:942-944 reads: `print("ERROR: validation failed. Aborting.", file=sys.stderr)` then (line 944) `print("Working tree is unchanged — fix the issues and re-run.", file=sys.stderr)`. The comment above it (lines 932-936) says: "If anything fails, publish aborts without touching any file and the working tree is guaranteed untouched." run_checks (publish.py:332) runs `npm run build` (publish.py:399; scripts/llm-ext/package.json "build": "tsc --noEmit && node esbuild.config.mjs"), and scripts/llm-ext/dist/benchmark.js and scripts/llm-ext/dist/llm-ext.js are git-tracked, so a build that rewrites them leaves the tree dirty when a later check fails, and the next run stops at its pre-flight dirty-tree check. Reported by the main agent (the spec of 2026-11-19): the build rewrote dist/benchmark.js and dist/llm-ext.js in a failed publish run; not re-measured by the worker. Done when: the message is true (restore the tracked dist files on a failed check, or stop claiming the tree is unchanged) and a test or a manual check shows the tree state after a failing run.

## Approval log

- 2026-11-19T01:07:19+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T20:40:51+0100 — SUPERSEDED by main-agent@llm-externalizer-plugin. duplicate of EWU9OAYI: same defect, publish.py line 944 prints Working tree is unchanged after run_checks npm run build rewrote the tracked dist files; EWU9OAYI covers it plus the dry-run and CPV-failure paths and has a testable acceptance list.
