---
trdd-id: VFIWQ6A6
title: Pass --offline to the llama-server spawned for the local fallback
column: backburner
status: tasked
created: 2026-11-18T06:52:29+0100
updated: 2026-11-18T06:52:29+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T06:52:29+0100
---

# Pass --offline to the llama-server spawned for the local fallback

Derived from TRDD-4W3Q2B4S item 2. With the network partly up (Hugging Face reachable), llama-server picks the first matching file of the online listing (find_best_model, download.cpp:740-776 at llama.cpp 8642541b2) and may download a file other than the cached one llm-ext judged ready. The --offline flag (arg.cpp:3988-3993) makes llama-server use only its cache. Open: the broker spawn (broker/server.ts:730-765) does not know whether a job is a fallback job, so a flag must be plumbed through; whether the server argv identity rejects a reused server spawned with a different flag was not read. Do it only if the partial-outage case is observed.

## Approval log

- 2026-11-18T06:52:29+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
