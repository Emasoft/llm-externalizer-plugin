---
trdd-id: P10QMUW7
title: --estimate prints the paid gate text that claims a benchmark is running
column: dev
status: tasked
created: 2026-11-19T04:53:47+0100
updated: 2026-11-19T05:48:39+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T04:53:47+0100
implementation-commits: [16426995]
---

# --estimate prints the paid gate text that claims a benchmark is running

cli/main.ts:996-1005 (the --estimate branch) prints profileGateRefusal's message verbatim except for the free empty-pool case, which TRDD-CQSODQ78 rewrote because an estimate starts nothing. For the generated, never-benchmarked paid profile the gate returns paidBenchmarkInProgressMessage (dynamic-maintainer.ts:1305, text at :1412-1438): 'paid profile is not benchmarked yet and is being benchmarked now (typically ~15 minutes) — re-run this command when it finishes. Progress: <cfg>/default-profile-paid.log'. Under --estimate dispatch is never reached, so no benchmark and no detector start; a worker run (reports_dev/fp2saf4p-6910/, items i9 i9b i9c, 14.7.3 and HEAD) found no progress log and no process afterwards (one ps snapshot, weak runtime evidence; source evidence: main.ts:991 comment 'the real run is gated in dispatchCallTool, which this branch never reaches'). Fix: in the estimate branch, say what is true for the unpopulated paid case (nothing started; run the command once without --estimate to start the benchmark, then re-run --estimate), with a test. Open question to check while fixing: whether the REAL command starts the paid benchmark at all, since index.ts:4924-4962 starts a profile update only for reason empty-pool-refreshable and otherwise returns gate.message unchanged (the detector scheduled at :4923 runs after dispatch). Found while working TRDD-FP2SAF4P item 9.

## Approval log

- 2026-11-19T04:53:47+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T05:48:39+0100 — column → dev. landed in 16426995 (main agent)

## Notes

2026-11-19T05:48:35+0100 main agent: done in 16426995. (a) The never-benchmarked paid gate (dynamic-maintainer.ts dynamicProfileGate) sets reason paid-unpopulated only when no paid sweep is running, queued or opted out (paidBenchmarkStartableByRealCommand); cli/main.ts --estimate then prints "paid profile: not benchmarked yet, and nothing is benchmarking it: an estimate starts no work. Run the command once without --estimate to start the paid benchmark (needs a valid OpenRouter key; about 15 minutes; it spends from the daily paid-benchmark budget), then re-run --estimate." Where a sweep is running, queued or opted out the old gate text is already true and is kept. (b) With $OPENROUTER_API_KEY and the plugin option unset the gate refuses with "paid profile is not benchmarked yet, and $OPENROUTER_API_KEY is not set, so no benchmark can start: export it and re-run." on the real path and under --estimate; gate and detector read the key through config.ts openRouterDetectorKey. Static trace, not run (worker report reports_dev/p10-trace/20261119_053811+0100-paid-nokey-trace.md; the load-bearing lines re-read by the main agent): the benchmark child reads its key only from those two variables (benchmark/index.ts resolveApiKey 145-153, preflight 274-282, called in main() at 654 before the populate dispatch at 906), so with no key no paid request starts, also with a fresh catalog cache or a profile api_key. Residual: a present but invalid key, and the 60 s per-profile detect throttle, can still leave a real run that starts nothing. Tests (worker runs, counts and the six P10QMUW7 test names checked by the main agent in the captures): dynamic-maintainer 74/74, profile-accept 25/25, profile-detector 22/22, config 227/227. Open: release at the next publish.
