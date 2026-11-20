---
trdd-id: YLTYAQUU
title: Release workflow keeps the setup-uv cache despite a zizmor cache-poisoning finding
column: todo
status: tasked
created: 2026-11-19T23:14:43+0100
updated: 2026-11-20T02:06:51+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: security
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T23:14:43+0100
implementation-commits: [40618c3d]
---

# Release workflow keeps the setup-uv cache despite a zizmor cache-poisoning finding

zizmor 1.30.1 (--offline --no-config) flags cache-poisoning (HIGH, audit confidence Low) on astral-sh/setup-uv with enable-cache true in .github/workflows/release.yml, a tag-triggered job that publishes release artifacts. a4281164 removed the npm cache this session had added and kept the uv cache with an accepted-risk comment (the only collaborator is the owner; branch and tag rulesets are active), because turning it off makes every release build CPV cold, 12-20 min by the workflow comment (not measured), against a 30-minute cap. Task: measure a cold release run; if it fits the cap with margin, turn the cache off; otherwise scope the cache so a release restores only a cache a tag run wrote, and re-run zizmor.

## Approval log

- 2026-11-19T23:14:43+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] zizmor --offline --no-config reports no cache-poisoning finding on release.yml, and a release run passes under its timeout

## Notes

2026-11-20: 40618c3d sets enable-cache: false for setup-uv in release.yml (the only workflow with contents: write that creates a release; checked by grep on 2026-11-20: ci.yml has contents: read (top level, line 15) and no release step; windows.yml has permissions: {} at top level (line 19), contents: read on its job (line 26), no release step, and one upload step (line 121) for a test-output artifact only; notify-marketplace.yml has contents: read, no cache, and sends a repository-dispatch with secrets.MARKETPLACE_PAT). zizmor 1.25.2 on the committed file: no findings (2 suppressed); actionlint exit 0, both run by the main agent. Past Release runs took 2m11s-4m36s wall time by a worker's gh run list; v14.1.0 after a 57-day gap took 3m29s (cache eviction not confirmed). Stays open until a tag release runs green with the cache off.
2026-11-20 (worker re-check): zizmor 1.25.2 (run via uvx) and the installed zizmor 1.30.1 both print No findings to report (2 suppressed) on the committed release.yml, which is identical to 40618c3d and HEAD. The 1.30.1 cache-poisoning finding in the body was on the file before 40618c3d. The workflow claims above were re-checked by grep in this worktree: windows.yml has permissions: {} at top level (line 19) and contents: read on its job (line 26); enable-cache: false is at line 44 of release.yml at 40618c3d.
