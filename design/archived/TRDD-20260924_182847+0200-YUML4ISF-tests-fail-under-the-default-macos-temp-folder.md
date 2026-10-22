---
trdd-id: YUML4ISF
title: Tests fail under the default macOS temp folder
column: complete
status: archived
created: 2026-09-24T18:28:47+0200
updated: 2026-10-07T12:36:07+0200
current-owner: agent
created-by: agent
task-type: bugfix
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: agent
approval-datetime: 2026-09-24T18:28:47+0200
implementation-commits: [d54f211a, b22bfae8]
---

# Tests fail under the default macOS temp folder

- Symptom: on a normal macOS terminal (TMPDIR under /var/folders/...), `npm test` fails about 80 tests with "Config directory '...' is outside allowed paths". Measured 2026-09-24: about 80 failures in 10 core test files on a git-archive copy of da3a18b (that copy launches the stale committed dist/, so the count is approximate); the same set plus one new test on the 6d9fffe tree. Agents and Linux CI never see it (their temp folder is under /tmp).
- Cause: config.ts getConfigDir's path guard accepts only the home folder or realpath("/tmp"); several tests (dynamic-maintainer, index, profile-detector) create their config folder under os.tmpdir(). test-hermetic-config.ts already uses "/tmp" for exactly this reason.
- Remedy (decide before implementing): recommended, make the tests create their config folders under realpath("/tmp"), as test-hermetic-config.ts already does. Not recommended, letting the guard also accept realpath(os.tmpdir()): os.tmpdir() follows TMPDIR, which the caller's environment controls, so any TMPDIR value would widen a path-traversal guard.
- Acceptance: npm test passes with the default macOS TMPDIR and with TMPDIR under /tmp; a test asserts that config.ts's guard still rejects a config folder outside the home folder and /tmp.

## Approval log

- 2026-09-24T18:28:47+0200 — MANDATE issued by agent (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-07T04:47:27+0200 — column → dev. USER 2026-10-07: complete all TRDDs; park lifted
- 2026-10-07 — Remedy decided by main-agent (coordinator default, the card recommended option): tests create their config folders under realpath("/tmp") as test-hermetic-config.ts does; the guard in config.ts is NOT widened. Worker dispatched.
- 2026-10-07 — worker report will be written under reports/llm-ext-release/ with the suffix -yuml4isf-impl.md; the card stays in dev until that report is verified and the change committed.
- 2026-10-07T12:36:07+0200 — COMPLETE by main-agent@llm-externalizer-plugin. landed d54f211a and b22bfae8; acceptance verified.

## Acceptance

- [x] npm test passes with the default macOS TMPDIR and with TMPDIR under /tmp (3116 passed / 5 skipped and 3115 / 6 after b22bfae8).
- [x] A test asserts config.ts's guard still rejects a config folder outside the home folder and /tmp, including a real folder under the default OS temp dir (ran and passed on the default macOS TMPDIR).
