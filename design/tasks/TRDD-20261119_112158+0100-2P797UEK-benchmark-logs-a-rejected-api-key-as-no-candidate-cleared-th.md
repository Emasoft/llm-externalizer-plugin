---
trdd-id: 2P797UEK
title: Benchmark logs a rejected API key as no candidate cleared the price ceiling
column: complete
status: tasked
created: 2026-11-19T11:21:58+0100
updated: 2026-11-19T11:57:34+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-19T11:21:58+0100
implementation-commits: [0cf82746]
release-via: publish
---

# Benchmark logs a rejected API key as no candidate cleared the price ceiling

Found by the TRDD-0QQVTUCF trace (reports_dev/0qqvtucf/20261119_104754+0100-invalid-key-trace.md). With an invalid OPENROUTER_API_KEY the paid benchmark sends 11 calls that all return HTTP 401, then fails in about 1 s with the message "no candidate cleared the $1.30/1M price ceiling", and recordBenchmarkFailure books it. The log names the wrong cause; the user is sent to the price ceiling instead of the key. Expected: when every call is rejected with 401 (or 403), the failure message says the key was rejected and names the status. Acceptance: a test that drives the benchmark failure path with 401 replies through the existing fetch seam asserts the key-rejected message; the price-ceiling message stays for a real ceiling miss.

## Approval log

- 2026-11-19T11:21:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-19T11:57:34+0100 — column → complete by main-agent@llm-externalizer-plugin. fixed in 0cf82746; release via the next publish

## Acceptance

- [x] When every benchmark call is rejected with HTTP 401 or 403, the failure message says the OpenRouter API key was refused and names the status: 0cf82746 (benchmark/index.ts, runPopulatePaidDefaultProfile).
- [x] A test drives the failure path with 401 replies, and one with 403 replies, and asserts the key-rejected message: populate-default-profile.test.ts, describe "paid populate — failure reason (TRDD-2P797UEK)", through the real runKeywordSweep and the file's local HTTP stand-in for OpenRouter (startFakeOpenRouter, reached by the existing fetch redirect).
- [x] The price-ceiling message stays for a real ceiling miss: test "a real ceiling miss (ok rows priced above the ceiling) keeps the price-ceiling message", and a 401 mixed with a 500 keeps it too.

## Notes

2026-11-19T11:57:30+0100 main agent: fixed in 0cf82746; the file passes 38/38, re-run alone by the main agent, with tsc and eslint exit 0. Live check with a temp HOME and an all-zero dummy key, the same no-spend exception as the TRDD-0QQVTUCF runs (env -i, no keychain, never a real key): the progress log shows 11 calls rejected with HTTP 401 and then the FAILED line "every benchmark call was rejected with HTTP 401: the OpenRouter API key was refused" (reports/2p797uek/20261119_114822+0100-fix.md). recordBenchmarkFailure is unchanged, so a rejected key still books a failed run and its cooldown. Open: a run where every call gets a per-model 403 that is not about the key would also get the key message; no such run has been seen.
