---
trdd-id: YLTYAQUU
title: Release workflow keeps the setup-uv cache despite a zizmor cache-poisoning finding
column: todo
status: tasked
created: 2026-11-19T23:14:43+0100
updated: 2026-11-19T23:14:46+0100
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
---

# Release workflow keeps the setup-uv cache despite a zizmor cache-poisoning finding

zizmor 1.30.1 (--offline --no-config) flags cache-poisoning (HIGH, audit confidence Low) on astral-sh/setup-uv with enable-cache true in .github/workflows/release.yml, a tag-triggered job that publishes release artifacts. a4281164 removed the npm cache this session had added and kept the uv cache with an accepted-risk comment (the only collaborator is the owner; branch and tag rulesets are active), because turning it off makes every release build CPV cold, 12-20 min by the workflow comment (not measured), against a 30-minute cap. Task: measure a cold release run; if it fits the cap with margin, turn the cache off; otherwise scope the cache so a release restores only a cache a tag run wrote, and re-run zizmor.

## Approval log

- 2026-11-19T23:14:43+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] zizmor --offline --no-config reports no cache-poisoning finding on release.yml, and a release run passes under its timeout
