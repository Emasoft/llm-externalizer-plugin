---
trdd-id: DTROKVVY
title: The completion.test.ts breaker test leaves its stderr spy installed after a timeout
column: backburner
status: tasked
created: 2026-11-05T01:20:14+0100
updated: 2026-11-05T01:37:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-05T01:20:14+0100
---

# The completion.test.ts breaker test leaves its stderr spy installed after a timeout

## Symptom

When the circuit-breaker test in scripts/llm-ext/src/provider/completion.test.ts times out, its stderr spy stays installed and hides the stderr of later tests in the file (TRDD-WTKO255N notes; inferred from the code of the breaker test, not observed in a run). Not fixed by 46b88412, which resets only timers.

## Acceptance

- [ ] the spy is restored in the file-level afterEach, with a WHY comment
- [ ] a whole-file run shows later tests stderr after a forced breaker-test timeout (temporary forced-timeout edit and a temporary stderr-writing probe test that writes with process.stderr.write, the call the spy replaces, in a scratch worktree copy, restored afterwards) and the same probe shows the stderr hidden with the fix removed

## Notes

Related: TRDD-5B4HPVKO, TRDD-WTKO255N.
2026-11-05T01:27+0100 premise read from code: captureStderr installs the spy, whose mockImplementation stores each chunk and returns true without writing it (scripts/llm-ext/src/provider/completion.test.ts:673-676, read 2026-11-05) and the breaker test restores it only in its finally (:888); the file afterEach (:44-64) restores timers and module state but no mocks; scripts/llm-ext/vitest.config.ts (working tree, which holds another session uncommitted edits) sets none of restoreMocks, mockReset or clearMocks, and its setupFiles (src/test-tmpdir-tracker.ts, src/test-hermetic-config.ts) and globalSetup (src/test-tmpdir-guard.ts, main process) restore no mocks. So after a timeout the spy stays installed until the abandoned body settles (inferred from code, not observed in a run).

## Approval log

- 2026-11-05T01:20:14+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
