---
trdd-id: 36L97JC9
title: GitHub CI and Release workflows fail on the Linux runner since 2026-10-31
column: dev
status: tasked
created: 2026-11-16T20:18:19+0100
updated: 2026-11-17T02:42:35+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-16T20:18:19+0100
implementation-commits: [ffdc019b, decc23b9]
---

# GitHub CI and Release workflows fail on the Linux runner since 2026-10-31

Measured 2026-11-16 from gh run logs. CI and Release have failed on every main push since b632ba52 (2026-10-31); last green 82b0331f (2026-10-27). Causes seen: (1) Release run 43936686211 at 925e8ecb: tests/test_publish_failed_push.py and tests/test_publish_runs_git_in_repo_root.py fail with FileNotFoundError git-cliff (not installed on the runner). (2) CI run 43879351185 at a411a6a8: src/classifiers/l2/local-decider.test.ts listenersOf, 3 tests: lsof failed (spawn /usr/sbin/lsof ENOENT). (3) same run: src/calibration/phase-c.test.ts 'a candidate short of free memory' asserts the largest candidate fits free memory above a 1 % floor; runner free 14183 MiB, candidate 21677211648 bytes. CI at 925e8ecb not yet read. Acceptance: each cause fixed at its root (no test skipped to hide a failure; a platform gate only where the feature itself is platform-specific, stated in a WHY comment), and the CI and Release runs of the next main push are green.

## Approval log

- 2026-11-16T20:18:19+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-16T21:05:02+0100 main agent: fix committed as ffdc019b on dev/after-14.3.0, local checks green (tsc, eslint, phase-c and local-decider tests 106/106, the two pytest files 7/7, actionlint); ci.yml has one job (build), so the git-cliff step (line 110) runs before the pytest step (line 140). PROOF PENDING: the CI and Release runs of the next main push. Plan: carry it in the 14.4.1 patch publish (publish.py --patch, foreground, host load well below 100); then read gh run list --repo Emasoft/llm-externalizer-plugin for the CI and Release runs of that commit and close this card only if both are green.
2026-11-16 23:00+0100: Linux evidence for 9e6069d7 (v14.4.1). Release run 43961101755 succeeded (git-cliff step works; assets SHA256SUMS, sbom.spdx.json, validation-report.txt attached). CI run 43961101395: stage 1 passed on Linux (343 files passed, 5 skipped; 6350 tests passed, 14 skipped, the 7 beyond macOS all platform gates: 3 darwin lsof, 2 darwin governor readings, 2 Apple-silicon locals-mlx), then the job was CANCELLED by timeout-minutes 20, nine minutes into stage 2. Stages 2-4 had never run on Linux (run 43936688059 shows one vitest RUN banner). Stage 2 also fetches fd7c3862 for the legacy-broker test (broker.test.ts:1682); GitHub has no such commit (API 422), so that test cannot pass on CI. Next: diagnostic PR run with a 120 min ceiling, then the final ceiling from measured durations.
2026-11-16 23:05+0100: the 120 min ceiling (32a7024e) was applied without a harness review of its proposal. A diagnostic PR is impossible: the pre-push hook refuses any push not made by scripts/publish.py, so every Linux CI run needs a release. Checked all 5 CI runs since 2026-10-28: only 43961101395 reached stage 2. Local branch ci/linux-stage-timing (worktree builds_dev/ci-linux-stage-timing) stays unpushed.
2026-11-17 01:28+0100: v14.5.0 CI run 43983678292 (65a0f055, 120 min ceiling): Release 43983677848 green. CI stage 1 green on Linux (344 files, 6381 passed, 15 skipped, 611 s). Stage 2 ran on Linux for the FIRST time: 1062 s, 2 failed, 209 passed, 10 skipped: (a) broker.test.ts 'kill safety > a failed ps is an error, never no process' (promise resolved instead of rejecting: the ps-failure injection does not fail on Linux); (b) governor-load.test.ts 'RAM: a load that does not fit waits and names RAM' (gave up after 60000 ms waiting for the load to wait on RAM: Linux memory reading differs); plus a TEMP-DIR LEAK error at close. Stages 3-4 not reached. NEXT: fix (a), (b) and the leak (Linux-only causes, read the tests), then set the final ceiling: measured stage 1 + stage 2 = about 28 min, stages 3-4 locally about 2 min, so about 30 min of tests plus setup; plan 50 min. Log: gh run view 43983678292 --log-failed.
2026-11-17 01:32+0100: correction to the previous note. (a) VERIFIED by reading broker.test.ts and local-llama-server.ts:198-204,520: the first assertion (processSnapshot rejects when PATH is emptied) holds on Linux; the second, readCommandLine(process.pid) rejects, cannot fail on Linux because readCommandLine reads /proc/<pid>/cmdline there and never runs ps, so it resolved with this process argv (9 parts). Production code is correct; the test assertion is macOS-only. Fix: on Linux assert the /proc read returns the live argv, keep the reject assertion for darwin. (b) governor-load RAM-wait: cause NOT known; candidates are Linux memory accounting, a slow 4-core runner, the tiny-model sizes, or the 60 s wait; read the test before fixing. The temp-dir leak may be a side effect of (b) giving up mid-run: read the full leak line first. Durations: stages 1-2 measured about 28 min on Linux (stage 2 includes a 60 s failed wait); stages 3-4 never ran on Linux; set the final ceiling only after a full green run.
2026-11-17T01:47:05+0100 CI 43983678292 TEMP-DIR LEAK cause VERIFIED: the entry is /tmp/llm-ext-llama-cache, the persistent model cache the broker and governor tests use on purpose (LLAMA_CACHE const in 5 test files; ci.yml step Cache llama models). Its key hashes broker.test.ts, which 3ed140b7 changed, so the run logged Cache not found and the tests created the dir during the run; its name matches PROJECT_MARKER in test-tmpdir-guard.ts, so the guard counted it as new. On a cache hit, and on a dev machine that already has it, it pre-exists and is not flagged. It is not caused by the RAM-wait failure. Proposed fix: exempt that exact path in the guard (a named list of persistent caches, with the why), not a CI-only mkdir. RAM-wait (b): the failing wait is line 982, the waiting broker never logged the RAM-wait message within 60 s; cause still unknown (the broker log is not in the CI output).
2026-11-17T02:42:34+0100 decc23b9 (branch dev/after-14.3.0, not pushed, not released): guard exempts /tmp/llm-ext-llama-cache exactly; RAM-wait until() prints broker log tails on timeout (diagnostic only, the RAM failure is not fixed). Exemption checked by ONE direct node call of setup()/teardown() with the cache moved aside (the move happened before setup() took the run lock), not by a vitest run. OWED: UBS on decc23b9 (pre-commit scan skipped at 180 s under load) and a Linux CI run.
