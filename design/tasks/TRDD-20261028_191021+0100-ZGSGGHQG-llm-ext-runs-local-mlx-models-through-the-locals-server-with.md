---
trdd-id: ZGSGGHQG
title: llm-ext runs local MLX models through the Locals server with a mac-only locals-mlx profile
column: todo
status: tasked
created: 2026-10-28T19:10:21+0100
updated: 2026-10-28T19:25:48+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: user
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-10-28T19:10:21+0100
---

# llm-ext runs local MLX models through the Locals server with a mac-only locals-mlx profile

## Approval log

- 2026-10-28T19:10:21+0100 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## User directive (verbatim, 2026-10-28)

> now i need you to add this mac-only profile called 'locals-mlx'. this profile must only execute local models in mlx format, and it must use the locals server:
> `https://github.com/Generated-Computers/Locals`. I already installed the latest version (with `uv tool install https://github.com/Generated-Computers/Locals.git --python 3.12`). The command to start the server is this: `locals serve --model LiquidAI/LFM3-1.7B-MLX-4bit --port 9090`

## Related

TRDD-1OOAH3LD (local_llama via llama.cpp; its server-supervisor plan design/specs/TRDD-1OOAH3LD-increment-2a-plan.md may share a seam with this profile) and TRDD-UT7UC025 (calibration of new models applies to every profile).

## User decisions 2026-10-28

Q: locals-mlx: who starts the Locals server when port 9090 is closed? USER answer verbatim: "llm-ext runs locals start (Recommended)" - llm-ext runs `locals start --model LiquidAI/LFM3-1.7B-MLX-4bit --port 9090` itself; Locals manages its own background process and `locals stop` stops it.
Q: locals-mlx: should thinking be off by default, and on only for commands that need it (as for local_llama)? USER answer verbatim: "Off by default (Recommended)"
Facts: reports/locals-mlx/20261028_191159+0100-facts.md (Locals 0.2.1, OpenAI-compatible API on /v1, any model id accepted, thinking on by default, no API key, no idle flag, about 1.4 GB RSS, LFM3 MLX 4bit cached 946 MB).
USER directive verbatim (2026-10-28): "you do not understand Locals, you must read the readme.md. Locals is the first server that we can be use with multiple concurrent requests to the same local model, it handles concurrent requests batching andf even inmprove the speed as the number of requests in parallel!"
USER directive verbatim (2026-10-28): "you only need to change the port for every serve command."
USER directive verbatim (2026-10-28): "of course there is a limit at the number of concorrent requests, given by the memory available. so you must detect and monitor the available memory before starting another Locals server request."
Consequence: llm-ext sends several requests at once to a locals-mlx server (today it sends one at a time to any mode: local profile, index.ts:1117-1118 and rate-limiter.ts:176). Before each additional request it checks free system memory and the memory Locals reports at /stats, and sends only when the request estimated memory fits; the number at once is the lower of the calibrated best and what memory allows. Each server command gets its own port (reading: one server per model, each on its own port; to be confirmed). Measured on this Mac, LFM3-1.7B on port 9090: 69, 242, 357, 399 tok/s at 1, 4, 8, 16 requests; 8 requests of about 6,000-token prompts reached 36 tok/s (report reports/locals-mlx/20261028_192216+0100-concurrency.md; the user Locals server on 8321 was running at the same time).
USER correction verbatim (2026-10-28): "no, sorry, i was wrong.. the port must not change for every request. all requests can be served by the same port of the same server."
Consequence: SUPERSEDES the earlier port reading (one server per model on its own port). One Locals server on one port serves every concurrent request; llm-ext sends its parallel requests to that same server and port.
USER directive verbatim (2026-10-28): "but you need to check the free memory before every new request. but read the documentstion of Local to see more precise details, i may be wrong."
