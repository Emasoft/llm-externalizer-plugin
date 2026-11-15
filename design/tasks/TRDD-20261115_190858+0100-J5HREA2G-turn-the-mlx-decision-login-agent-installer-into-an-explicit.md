---
trdd-id: J5HREA2G
title: Turn the mlx-decision login-agent installer into an explicit opt-in command
column: backburner
status: tasked
created: 2026-11-15T19:08:58+0100
updated: 2026-11-15T19:10:27+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-15T19:08:58+0100
---

# Turn the mlx-decision login-agent installer into an explicit opt-in command

Removed from 14.3.0 on 2026-11-15: the SessionStart hook entry in hooks/hooks.json and its files scripts/hooks/install-decider-agent.sh and scripts/llm-ext/src/decider-agent-hook.test.ts (also its entry in scripts/llm-ext/vitest.config.ts). Why: CPV blocks the publish with RC-39 MAJOR (persistence) on scripts/hooks/install-decider-agent.sh lines 22, 228, 229 (the script writes ~/Library/LaunchAgents/com.llm-externalizer.mlx-decision.plist and bootstraps it), and CPV Gate A forbids allow-listing. USER decision 2026-11-15, verbatim answer: 'Leave it out (Recommended)'; the option read: 'Remove the session-start hook and its script from 14.3.0. The local fallback still works: llm-ext uses a decision server that is already running, such as the one on this machine. A follow-up card turns the installer into an explicit command that users run themselves.' Restore the removed files from commit 24a451df9909c32f45e887211a8c836ac843b17e (git show 24a451df:scripts/hooks/install-decider-agent.sh). To do: (1) an explicit command or slash command that installs the LaunchAgent only when the user runs it, never from a hook; (2) a CPV run proving that shipping it passes RC-39; (3) restore the hook test as a test of that command.

## Approval log

- 2026-11-15T19:08:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Removal note for existing installs

Users who already got the login agent from an earlier version can remove it with: launchctl bootout gui/$(id -u)/com.llm-externalizer.mlx-decision, then delete ~/Library/LaunchAgents/com.llm-externalizer.mlx-decision.plist. Candidate line for the 14.3.0 release notes; not yet written there.
