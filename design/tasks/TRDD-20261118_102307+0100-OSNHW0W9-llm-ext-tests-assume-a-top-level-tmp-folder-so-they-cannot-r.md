---
trdd-id: OSNHW0W9
title: llm-ext tests assume a top-level tmp folder, so they cannot run on Windows without it
column: todo
status: tasked
created: 2026-11-18T10:23:07+0100
updated: 2026-11-20T02:06:52+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T10:23:07+0100
parent-trdd: 61EINA10
implementation-commits: [9315510b]
---

# llm-ext tests assume a top-level tmp folder, so they cannot run on Windows without it

Found 2026-11-18 by the first Windows CI run (TRDD-61EINA10, run on v14.7.1). The unit tests and their setup assume a top-level /tmp: test-tmpdir-guard.ts:68 LOCK_PATH is join("/tmp", ...), test-hermetic-config.ts:37 and :44 call mkdtempSync(join("/tmp", ...)), and the config-dir guard (config.ts:915) allows /tmp besides the home folder. 162 source files mention "/tmp" (a count of mentions, not of failures). Windows runners have no D:\tmp, so the first run stopped in globalSetup before any test; the Windows workflow is to create /tmp as a stopgap. Fix: one test temp root, /tmp on macOS and Linux (kept there for the cross-session lock, see test-tmpdir-guard.ts:65) and os.tmpdir() on win32, used by the guard, the hermetic config and the tests; then remove the workflow step. The shipped CLI is not affected in its default setup: the config folder defaults to the home folder, which the guard always allows.

## Approval log

- 2026-11-18T10:23:07+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-20T00:28:31+0100 — column → todo by main-agent@llm-externalizer-plugin.

## Notes

2026-11-18T16:54:35+0100 Run 44305836777 G1 (36 tests) config dir outside allowed paths (RUNNER~1); G1 shares the config guard (config.ts:918-921) with this card but has its own card, TRDD-LA1MA1EL; verify after the fix, else keep both.
2026-11-20 (main agent read config.ts:895-922): getConfigDir resolves the config dir and homedir() with plain realpathSync and compares them by string prefix. On the Windows runner the temp dir is C:\Users\RUNNER~1\AppData\Local\Temp\..., the home folder in 8.3 short form, while home resolves to C:\Users\runneradmin, so the prefix check fails. INFERRED, not run: realpathSync.native returns the long name, which would fix group G1 (36 failures) without widening the allowlist. Map: reports_dev/windows-ci-map/20261119_232646+0100-windows-failure-map.md.
2026-11-20: shares the inferred cause with TRDD-LA1MA1EL (G1); whether it is one defect and whether fix 9315510b works are unverified until the next Windows CI run.
