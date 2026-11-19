---
trdd-id: 0QQVTUCF
title: Invalid OpenRouter key or the 60 s detect throttle can leave a real paid-profile run that starts no benchmark
column: complete
status: tasked
created: 2026-11-19T09:03:58+0100
updated: 2026-11-19T11:52:02+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T09:03:58+0100
implementation-commits: [5706e07d, b587bd26]
release-via: publish
---

# Invalid OpenRouter key or the 60 s detect throttle can leave a real paid-profile run that starts no benchmark

Residual of TRDD-P10QMUW7 (commit 16426995, shipped in v14.7.5). Per the static trace in reports_dev/p10-trace/20261119_053811+0100-paid-nokey-trace.md (not run), with the never-benchmarked generated paid profile, a key that is present but invalid, or a second real run inside the 60 s per-profile detect throttle, can still leave a real run that starts no paid benchmark; what that run prints in those cases was not checked. Also not shown: that a real run with a valid key starts the sweep; that needs a real paid key, which only the USER can authorize. Verify the first two cases on the built CLI with a temp HOME and LLM_EXT_CONFIG_DIR, LLM_EXT_INSTALL_RULE=0 and a deliberately invalid key (never a valid paid key), then make the printed message true for both cases, with a test. Size S.

## Approval log

- 2026-11-19T09:03:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T11:44:06+0100 — column → complete. code done and verified: 5706e07d, b587bd26; release via the next publish
- 2026-11-19T11:51:41+0100 — column → dev. back to dev to write the acceptance checklist the completion gate needs
- 2026-11-19T11:52:02+0100 — column → complete. acceptance boxes met: 5706e07d, b587bd26; release via the next publish

## Notes

2026-11-19T11:44:03+0100 main agent: done in code in two commits. 5706e07d (F2): plain detection honours the failure cooldown (profile-detector.ts detectOnce returns "failure backoff" before populate); before it, a second real run inside the backoff spawned a second benchmark and booked a second failure, raising the cooldown from 15 minutes to 1 hour (test homes home-5 and home-11 under reports_dev/0qqvtucf: failCount 2, cooldown 3600 s, read by the main agent). b587bd26 (F1): the paid not-benchmarked message says what is really happening (a benchmark running, the last attempt failed with the retry time, candidates queued, or a start asked). Premise (a) of this card was wrong: an invalid key does start a benchmark, which fails in about 1 s on 401 replies (reports_dev/0qqvtucf/20261119_104754+0100-invalid-key-trace.md); the old text promised a run of about 15 minutes. Case C after the fix (reports/0qqvtucf-fix/20261119_112458+0100-followup-and-case-c.md): the second run printed the failed-attempt message with the retry time, and the state kept failCount 1 with a 15-minute cooldown. Not shown: that a real run with a valid paid key starts the sweep; that needs a valid paid key, which only the USER can authorize. The rejected key logged as no candidate is TRDD-2P797UEK. Tests, each file alone: profile-detector 24, dynamic-maintainer 77, profile-accept 25, default-profiles-runner 32.

## Acceptance

- [x] Case (a), a present but invalid key, checked on the built CLI with a temp HOME and an all-zero dummy key: the benchmark starts and fails in about 1 s on 401 replies, so premise (a) was wrong (reports_dev/0qqvtucf/20261119_104754+0100-invalid-key-trace.md).
- [x] Case (b), a second real run inside the 60 s detect throttle, checked on the built CLI: it spawned a second benchmark inside the failure backoff (case5-run2 and case11-run2); fixed in 5706e07d with tests in profile-detector.test.ts.
- [x] The printed message is true in both cases, with tests: b587bd26 (dynamic-maintainer.test.ts, one test per branch b, c and e). Seen live after the fix: only the second run of case C, which printed the failed-attempt message with the retry time (reports/0qqvtucf-fix/20261119_112458+0100-followup-and-case-c.md); the first-run message after the fix rests on the branch tests.
