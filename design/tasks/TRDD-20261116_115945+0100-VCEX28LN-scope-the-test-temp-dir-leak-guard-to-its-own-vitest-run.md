---
trdd-id: VCEX28LN
title: Scope the test temp-dir leak guard to its own vitest run
column: human_review
status: tasked
created: 2026-11-16T11:59:45+0100
updated: 2026-11-16T20:16:02+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T11:59:45+0100
implementation-commits: [b239d2b4]
---

# Scope the test temp-dir leak guard to its own vitest run

src/test-tmpdir-guard.ts:35-45 snapshots the whole machine /tmp and tmpdir() and fails on ANY new entry matching /llm[-_]?ext/i. A concurrent vitest run on the same host (another worktree, an agent, a publish stage) therefore trips it with that run's in-flight temp dirs. Evidence 2026-11-16: the 14.3.1 publish dry run failed in its THIRD npm test stage (vitest run src/governor/governor-burn.test.ts, 11:20:54-11:22:06; the stages are chained with &&, so the first two passed). That file has its own runCli and never imports test-helpers.ts, so it cannot create the 19 names it was blamed for (1 __llm_ext_cfg_, __llm_ext_test_mode1, 17 __llm_ext_unit_output_); a worker vitest run that included index.test.ts ran 11:21:18-11:22:49 in another worktree and was in flight at that teardown. The two leak-probe runs (conc-A on vitest 4.1.8, 11:32:16-11:33:52, LEAK 40; conc-B on 4.1.12, 11:32:46-11:33:57, LEAK 24) overlapped each other and a worker index.test.ts run (11:32:50-11:34:00), so neither was isolated and they say nothing about the vitest version; a guard-only observer run reproduced the 19-entry shape deterministically next to a live index.test.ts run (reports_dev/leak-fix/20261116_115619+0100-report.md). Fix (proposal): the guard sets a per-run id in the environment (for example LLM_EXT_TEST_RUN_ID) in globalSetup; every test temp prefix (test-helpers.ts:234, 246, 372, index.test.ts:468, and the mkdtemp tracker) embeds it; teardown flags only entries carrying this run id, plus entries with no run id that were created by this process tree. Detection of a real own leak must not weaken: add a negative-control test that leaks on purpose and must fail. Until then: never run two vitest processes on one host while the publish gate runs.

## Approval log

- 2026-11-16T11:59:45+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-16T16:13:10+0100 — column → testing by main-agent@llm-externalizer-plugin. lock landed in b239d2b4; proven with real single-file runs, full suite pending the pre-push run
- 2026-11-16T20:16:02+0100 — column → human_review by main-agent@llm-externalizer-plugin. shipped in v14.4.0 (b239d2b4); full npm test green with the lock; USER review of the agent decision that a second concurrent llm-ext vitest run on the machine fails fast

## Notes

2026-11-16T12:03:41+0100 main agent: leftover entries still in /tmp at 12:0x, older than any run now active: 43 __llm_ext_unit_output_, 2 __llm_ext_help_cfg_ and 1 __llm_ext_cfg_ dated 11:40-11:42 (a vitest run killed mid-file cannot run afterAll; at least one worker run was ended by a hook that stops processes); 170 __llm_ext_profile_*/profileflag_* entries (cfg, immut, upgrade) with mtime 00:00 from profile.test.ts, cli/profile-flag-and-output-dir.test.ts and settings-group.test.ts, creation time unknown because the mtime is not the creation time. The guard ignores entries that predate its snapshot, so none of these failed the 14.3.1 gate; whether the profile tests leave the immut dirs behind on a normal run is not checked. Check it when this card is worked.
- 2026-11-16T16:07:51+0100 main agent: first fix REJECTED, kept as git stash 'VCEX28LN claims-registry attempt (rejected 2026-11-16 ...)' in the dev/after-14.3.0 worktree, stash commit 2198765dbe6462f66e346ea921e334ea33e6ea43. It journaled every mkdir and mkdtemp of a run into a shared claims directory and subtracted other runs' claims at teardown. Rejected because, by the worker's own reproductions (report reports_dev/vcex/20261116_155306+0100-guard.md, not rerun by the main agent): a directory made by a spawned CLI child still failed an innocent concurrent run; a hardcoded name created first by another run stays masked, which hides a real leak (forbidden); and it added a claims registry plus mkdir wrappers in every test worker. Replacement in progress (main agent decision, advisor not consulted, local and reversible): one llm-ext test run per machine, an exclusive lock file under /tmp taken in the guard setup, a second run refused at once naming the holder and the manual fix, a stale lock (dead pid, or a pid reused by a process started after the lock, or an empty lock older than 10 s) replaced by an atomic rename. The leak check itself is unchanged. Consequence to weigh: two single-file vitest runs at once on one machine are refused too.
