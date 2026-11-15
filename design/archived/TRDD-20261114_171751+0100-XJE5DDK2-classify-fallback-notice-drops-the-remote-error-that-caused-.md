---
trdd-id: XJE5DDK2
title: classify fallback notice drops the remote error that caused it
column: complete
status: archived
created: 2026-11-14T17:17:51+0100
updated: 2026-11-14T17:33:37+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-14T17:17:51+0100
implementation-commits: [c630774b]
---

# classify fallback notice drops the remote error that caused it

Found 2026-11-14 by the TRDD-WYY3SPDX live check (reports_dev/wyy3spdx/20261114_171659+0100-remote-fallback-diagnosis.md). When the remote decision call fails with a class that escalates to the local decider (auth, payment, key-limit, in-flight-budget, rate-limited, not-found, unavailable, timeout, bad-response), and the local decider answers, the run exits 0. It prints only "no remote System One model answered; the local decider elephant-1 ... did (free, no API key used)". The remote error itself (measured: API error 402 Insufficient credits) is printed nowhere: not on stderr, not in the --json warning, not in history.log, and not with LLM_EXT_DEBUG=1. A paid model is silently replaced by a different local model, and the user cannot tell why. The verdicts are not equivalent, so a whole live check was void without anyone being told.

Code (from the diagnosis, to confirm at card start): run-decision.ts exec catch, about lines 440-489; the local.ok branch at about :486-489 builds the warning from local.notice (l2/local-fallback.ts:301), which has no access to the caught error. classify ping already prints the remote error (commands/ping.ts:175).

Fix: in the local.ok branch, add the remote failure to both the stderr line and the local_decider warning, for example "<notice>; the remote model failed: <e.message>". The message is already redacted. Put e.class in the --json warning detail. Test: a recorded 402 reply plus a local decider answer gives a warning and a stderr line that contain the remote message and class. Without the fix, the test fails.

Out of scope (a policy question, see TRDD-O93LFMF3): whether a 402 should escalate at all.

## Approval log

- 2026-11-14T17:17:51+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-14T17:33:37+0100 — COMPLETE by main-agent@llm-externalizer-plugin. fixed in c630774b, verified live against the real 402.

## Acceptance

- [x] The stderr line and the local_decider warning carry the remote error message and class; a recorded-402 test fails without the fix (c630774b).
- [x] Live, 2026-11-14 with the real 402: `classify label` printed '...; the remote model failed: API error 402: Insufficient credits. Add more using https://openrouter.ai/settings/credits (class payment)', exit 0 (reports_dev/xje5ddk2/logs/live-after.log).
- [x] Exit codes and the escalating classes unchanged; no doc quoted the old notice.
