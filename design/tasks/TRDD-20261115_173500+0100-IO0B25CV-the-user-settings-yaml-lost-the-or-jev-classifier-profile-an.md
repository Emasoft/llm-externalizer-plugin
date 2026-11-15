---
trdd-id: IO0B25CV
title: The user settings.yaml lost the or-jev classifier profile and active_classifier after 2026-10-29
column: todo
status: tasked
created: 2026-11-15T17:35:00+0100
updated: 2026-11-15T17:39:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T17:35:00+0100
---

# The user settings.yaml lost the or-jev classifier profile and active_classifier after 2026-10-29

Reported 2026-11-15 by the apple-docs-mcp Claude session (peer report, not verified here): ~/.llm-externalizer/settings.yaml has no or-jev profile and no active_classifier line, while backups/settings-before-local-profiles-*-20261029_120112+0100.yaml still has both. Without them, classify commands on this machine fail with 'classify rank needs a classifier profile'. Related: TRDD-4HRFC42S (tests could overwrite the real settings.yaml; guard landed 1616fb78), and the 2026-11-14 EB1XGLMJ STATE note that settings.yaml was rewritten on 2026-11-14 around 20:00 and that the local profiles vanished between 10-29 and 11-11. RELEASE BLOCKER for 14.3.0 (the release exists to give sessions the local Jev fallback). To do: (1) find every writer of settings.yaml in scripts/llm-ext/src and the conditions under which it drops a profile or a top-level key it did not generate; (2) fix so a regenerating write never drops a user-owned profile or active_classifier; (3) a test that a regenerate keeps an or-jev classifier profile and active_classifier; (4) restoring the user's own settings.yaml needs the USER's word (outside git, DS6OM3KX 2026-10-07 reading).

## Approval log

- 2026-11-15T17:35:00+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-15T17:39:27+0100 CHECKED by the main agent (read-only grep of profile-name lines only, no content diff, 2026-11-15). Live ~/.llm-externalizer/settings.yaml (mtime 2026-11-15 17:30, 3218 bytes) has profiles scouting, free, local_llama, locals-mlx; no or-jev, no paid, no active_classifier, no top-level active line. backups/settings.yaml.bak-pre-local-restore-20261114_200442+0100 already lacked or-jev and active_classifier (profiles scouting, free only). Both backups/settings-before-local-profiles-*-20261029_120112+0100.yaml have active free, or-jev, paid and active_classifier or-jev. So the loss happened between 2026-10-29 12:01 and 2026-11-14 20:04, and the classifier profile was already missing before today's 17:30 rewrite (what that rewrite changed is not known). The 17:30 rewrite is unattributed: candidates are two unisolated --version runs by a research worker (its report in reports_dev/sonnet-worker/20261115_173458+0100-classify-local-fallback-howto.md) or another session using llm-ext.
