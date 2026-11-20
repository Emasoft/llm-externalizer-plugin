---
trdd-id: NL4MGJVA
title: Test isolation dirs cfgiso and goviso are left behind in the temp folder
column: todo
status: tasked
created: 2026-11-20T03:36:53+0100
updated: 2026-11-20T03:46:25+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-20T03:36:53+0100
---

# Test isolation dirs cfgiso and goviso are left behind in the temp folder

## Approval log

- 2026-11-20T03:36:53+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Problem

2026-11-20T03:37:07+0100 Measured 2026-11-20 03:27 by the main agent: /private/tmp holds 132 cfgiso-* and 175 goviso-* dirs; cfgiso by modification date: 5 on 2026-11-17, 65 on 2026-11-18, 61 on 2026-11-19, 1 on 2026-11-20. None was created during a 2026-11-20 03:24-03:26 run of 18 single test files, which left none.
2026-11-20T03:37:08+0100 Source: scripts/llm-ext/src/test-hermetic-config.ts (vitest setup file) creates them with mkdtempSync when LLM_EXT_CONFIG_DIR / LLM_EXT_GOVERNOR_DIR are unset and removes them in afterAll; since TRDD-5D50HBXA it also creates scriso-* and outiso-*, which leak the same way if afterAll does not run. TRDD-5D50HBXA saw two empty scriso/outiso dirs left by a failing run (cause unproven).
2026-11-20T03:37:09+0100 Inferred, not verified: the leftovers come from runs that end without afterAll (full-suite runs killed by a timeout or signal, crashed vitest workers). Release tags exist on all three days (git tags, tag times): 2026-11-17 v14.5.0 and v14.6.0 to v14.6.4; 2026-11-18 v14.6.5 and v14.7.0 to v14.7.2; 2026-11-19 v14.7.3 to v14.7.6. A release is not proof that a full-suite run left a given dir; that link is unverified.
2026-11-20T03:46:24+0100 main agent (via card worker): carried over from archived TRDD-5D50HBXA, whose closing evidence covers only the scratch root (settings_edit.yaml mtime 03:08:44, 0 scriso/outiso). The three fixture chat reports in the real reports/llm-externalizer/ (chat-43f56a, chat-d29c63, chat-31c34f, mtime 2026-11-19 22:23:57) were never attributed to a test and are not shown fixed by commit 2471676d; no file newer than 2026-11-19 22:30 exists in that folder at 2026-11-20. Still open: find the writer of those reports. Also open: a test asserting isError false for a missing settings.yaml (TRDD-LFWV2DKG box 3 is backed by note-text assertions only).

## Plan

2026-11-20T03:37:09+0100 main agent: (1) find which runs leave the dirs: correlate dir mtimes with full-suite and publish run times, and run one single test file that fails, times out and is killed with SIGTERM, checking for leftovers after each; (2) make cleanup independent of afterAll for the kill path (for example a globalSetup teardown, or one per-run parent dir removed at start of the next run), and keep the leak-marker naming rule of test-hermetic-config.ts; (3) test: a vitest run killed mid-file leaves no isolation dir. Old dirs in /tmp may be removed (temp contents are disposable).
