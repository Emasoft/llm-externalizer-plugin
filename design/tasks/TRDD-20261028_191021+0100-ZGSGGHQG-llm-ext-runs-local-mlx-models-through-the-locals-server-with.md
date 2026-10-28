---
trdd-id: ZGSGGHQG
title: llm-ext runs local MLX models through the Locals server with a mac-only locals-mlx profile
column: todo
status: tasked
created: 2026-10-28T19:10:21+0100
updated: 2026-10-28T20:23:57+0100
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

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-28

- Goal: the /goal directive recorded verbatim under User decisions 2026-10-28.
- Phase now: (1) smoke-check all six models on private ports; (2) one proposal round on the delta (three models per profile = three servers per profile, per-route managed target, a third GGUF id kind repo/file.gguf); (3) implement 1OOAH3LD 2a-core + CI step, then locals-mlx L1, L3, L2, then calibration of six models, then all commands incl. mass-scouting and ensemble scan on both profiles.
- Plans: design/specs/TRDD-1OOAH3LD-increment-2a-plan.md (rev 4), design/specs/TRDD-ZGSGGHQG-locals-mlx-design.md.
- Not on the critical path: 2b, 2c, 2d, 2e, the --stop_on_errors TRDD.
- NEXT ACTION: program plan design/specs/local-profiles-goal-program.md (revision 2) needs its round-2 review, then P0 measurement (default n_ctx and RSS per model, memory table), then P1. Six-model smoke passed (reports/locals-mlx/20261028_200451+0100-six-model-smoke.md).

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
USER directive verbatim (2026-10-28, REPLACES the --no_stop_on_fail ruling): "no, maybe i'm wrong.. it should do by default the fallback in case of errors. instead the optional flag --stop_on_errors will make it fail and exit if a model is not responding or not found. But beware: not having enough memory is not a failure, it only put the requests in a queue, waiting fot the memory to be freed enough to run another request pending."
Consequence: default = on a model error (not responding, not found, managed server failed) llm-ext continues on the profile fallback models, as today; the optional llm-ext command flag --stop_on_errors makes the command fail and exit instead. --no_stop_on_fail is withdrawn. Lack of memory is never an error: requests wait in a queue until enough memory is free for the next pending one.
2026-10-28 design written after two review rounds, WAITING FOR USER APPROVAL: design/specs/TRDD-ZGSGGHQG-locals-mlx-design.md. Order L1 (preset, profile, gates), L3 (max_parallel, memory floor, liveness wait instead of a total timeout), L2 (managed start) after TRDD-1OOAH3LD 2a revision 4 is approved. Open: start method (locals start or the server module directly), idle kill, non-mac CI skip, reuse of a user Locals server, restoring ~/.locals/config.json port 8321 changed by an earlier measurement.
USER /goal directive verbatim (2026-10-28): "make the two new profiles (local-llama and locals-mlx) working perfectly, benchmarked and calibrated with the two models (`AtomicChat/LFM3-1.7B-Uncensored-GGUF` and `LiquidAI/LFM3-1.7B-MLX-4bit` respectively). Make also all commands to work with those 2 profiles, including the mass-scouting, since they cost little, but use a reduced context memory to make the models run faster in that case. ensemble scan can also be used by adding 2 additional local models to both: `mlx-community/Nanbeige4.2-3B-OptiQ-4bit` and `mlx-community/Qwen3.5-4B-MLX-4bit` (the gguf versions for llama.app are `bartowski/Nanbeige_Nanbeige4.2-3B-GGUF/Nanbeige_Nanbeige4.2-3B-Q6_K.gguf` and `insraq/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF/Qwen3.5-4B-EmperoAI-Qwen3.8-Distill-Heretic-Abliterated-MTP-GGUF-Q8_0.gguf`. now each profile has 3 models and can execute the ensemble scan. but check with the benchmarkks first, of ciurse. not only to calibrate but also to ensure they works at all."
Decided by main-agent under the /goal directive (not user-ruled; the user may override): 2a revision 4 approved for implementation; locals-mlx design approved for implementation; Locals started with the server module directly (option B); an idle Locals server is killed after 2 hours without requests, like local_llama; Locals tests skipped on non-mac CI with a printed reason; a user-started Locals server serving the same model is reused. Reading of "reduced context memory" for mass-scouting: a smaller per-request prompt budget for that command in the calibration record (the server context is fixed at start), to be confirmed by the user. Each profile gets 3 models, each on its own server and port (both engines serve one model per port). ~/.locals/config.json port 8321 changed to 9090 by an earlier measurement, not yet restored.
USER directive verbatim (2026-10-28, repeating the /goal with one addition): "since we are using Locals for all mlx models, you can drop the support for kiril." Consequence: Krill support is removed from llm-ext; every MLX model (including Nanbeige4.2 and Qwen3.5) runs through Locals; the earlier note that Nanbeige4.2 must run through Krill is superseded.
2026-10-28 program plan revision 2 reviewed twice; P6a (calibration design review plus a 30-minute LFM3 dry run) added before the overnight run; P10 command table with thresholds is a gate before the goal is complete. Open user question: may calibration restart its own server with a new context (refuse-on-change kept for user runs)?
USER answer verbatim (2026-10-28) to "may calibration restart its own server with a new context?": "yes calibration can handle thevcalibration server as it see fit. this is whynwe given a separated server to calibration processes." Consequence: calibration runs on its own separate server per model on a private port and controls its context freely; the user-facing servers keep refuse-on-change.
USER directive verbatim (2026-10-28): "remember to add safeguards that guarantee that only the main server of the local inference engine (whatever it is) and the benchmarking/tedting server of the same must exists at any given time. no third server must be allowed tombe spawned by llm-ext." Consequence: per local inference engine, llm-ext runs at most one main server and one benchmarking/testing (calibration) server at any time, with a safeguard that refuses to spawn a third. This withdraws the per-model one-server-per-port design of the program plan (three servers per profile); the three models of a profile must be served by the one main server (to be measured: llama.cpp router mode, Locals multi-model). P1 implementation paused.
Q: does the llama.cpp router (one llama-server serving all three GGUF models, with one internal child process per model) count as one server under the two-servers rule? USER answer verbatim: "One server (Recommended)". Q: how should locals-mlx run its three MLX models (Locals serves one model per server, measured)? USER answer verbatim: "Exception for Locals" - one main Locals server per model (three, about 6 GB) so ensemble members run in parallel; the one-main-server rule is relaxed for Locals only. Evidence: reports/llama-cpp-profile/20261028_202238+0100-single-server-multimodel.md.
