---
trdd-id: 2P797UEK
title: Benchmark logs a rejected API key as no candidate cleared the price ceiling
column: todo
status: tasked
created: 2026-11-19T11:21:58+0100
updated: 2026-11-19T11:21:58+0100
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
---

# Benchmark logs a rejected API key as no candidate cleared the price ceiling

Found by the TRDD-0QQVTUCF trace (reports_dev/0qqvtucf/20261119_104754+0100-invalid-key-trace.md). With an invalid OPENROUTER_API_KEY the paid benchmark sends 11 calls that all return HTTP 401, then fails in about 1 s with the message "no candidate cleared the $1.30/1M price ceiling", and recordBenchmarkFailure books it. The log names the wrong cause; the user is sent to the price ceiling instead of the key. Expected: when every call is rejected with 401 (or 403), the failure message says the key was rejected and names the status. Acceptance: a test that drives the benchmark failure path with 401 replies through the existing fetch seam asserts the key-rejected message; the price-ceiling message stays for a real ceiling miss.

## Approval log

- 2026-11-19T11:21:58+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
