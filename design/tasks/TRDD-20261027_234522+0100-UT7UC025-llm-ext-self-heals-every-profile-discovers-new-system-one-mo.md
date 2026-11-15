---
trdd-id: UT7UC025
title: llm-ext self-heals every profile, discovers new system-one models, falls back to a local small model
column: design
status: tasked
created: 2026-10-27T23:45:22+0100
updated: 2026-11-13T19:11:24+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-27T23:45:22+0100
eht: [5Q79QZM7, 28BAL5ER, 8HDAFJ3N, J7AIC7ZW, O93LFMF3, WSPV40Y5, 3CG178O7, PN0N4290, 78LZFUVJ]
---

# llm-ext self-heals every profile, discovers new system-one models, falls back to a local small model

## USER directive (verbatim, 2026-10-27)

> the llm-ext must never remain blocked or non-functional. it must always ensure the commands work. if anything is failing in any profile, default or not, it must attempt to fix it automatically. if a model is not working, or it is not available anymore, it must update the list of available models that are meeting the specs of the command and of the profile and benchmark them to verify they work, and update the profiles with these models. jev is only one for now, since there are no other system-one models on openroute at the moment, but they will appear and the code must be ready to discover them and use them if jev is not working. also worst case scenario, you must keep some small language model (smaller than 2B parameters) running locally. For example add support for these (but only download them if the HUGGINGFACE_API_TOKEN is available in the environment, and only on demand if the other models fail):

Example list pasted by the USER (verbatim):

https://huggingface.co/Nanbeige/models
https://huggingface.co/models?other=base_model:quantized:Nanbeige%2FNanbeige4.3-33B&sort=created
https://huggingface.co/Nanbeige/Nanbeige4.2-3B-DSpark
https://huggingface.co/Nanbeige/Nanbeige4.2-3B
https://huggingface.co/models?other=base_model:quantized:Nanbeige%2FNanbeige4.2-3B&sort=modified&search=mlx
https://huggingface.co/yugeshkarunamurthy/Nanbeige4.2-3B-oQ4e
https://huggingface.co/srv-sngh/Nanbeige4.2-3B-mlx-nvfp4
https://github.com/srvsngh99/Krill
https://huggingface.co/srv-sngh/models
https://huggingface.co/srv-sngh/bge-reranker-base-ane-lin8
https://huggingface.co/srv-sngh/Qwythos-9B-Claude-Mythos-5-1M-mlx-nvfp4
https://huggingface.co/srv-sngh/Unlimited-OCR-mixed-nvfp4
https://huggingface.co/srv-sngh/Qwen3.8-27B-mlx-4bit
https://github.com/srvsngh99/mini-krill
https://huggingface.co/mlx-community/Nanbeige4.2-3B-OptiQ-4bit
https://huggingface.co/vote-for-pedro/Nanbeige4.2-3B-mlx-4bit
https://huggingface.co/Nanbeige/Nanbeige4.3-33B
https://huggingface.co/spaces/inclusionAI/ming-image-0-1-design-demo
https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro?leaderboard_task_id=SWE_Bench_Pro&leaderboard_max_params=500B
https://huggingface.co/datasets/ScaleAI/SWE-bench_Pro?leaderboard_task_id=SWE_Bench_Pro
https://huggingface.co/collections/ornith-ai/ornith-15-mlx
https://huggingface.co/ornith-ai/Ornith-1.5-9B-MLX
https://huggingface.co/ornith-ai/Ornith-1.5-9B-MLX-6bit
https://huggingface.co/spaces/VIDraft/global-llm-leaderboard
https://huggingface.co/OrionLLM/OxCoder-9B
https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.kernel.increased-memory-limit
https://huggingface.co/ornith-ai/Ornith-1.0-35B
https://huggingface.co/ornith-ai/Ornith-1.5-9B
https://huggingface.co/LiquidAI/LFM3-1.7B
https://huggingface.co/spaces/akhaliq/lfm3-studio
https://huggingface.co/blog/LiquidAI/lfm3
https://huggingface.co/LiquidAI/LFM3-Audio-2B
https://huggingface.co/LiquidAI/d1-Omni-2B
https://huggingface.co/LiquidAI/LFM3-VL-2B
https://huggingface.co/LiquidAI/d1-3B
https://huggingface.co/LiquidAI/LFM2.5-8B-A1B
https://huggingface.co/LiquidAI/LFM3-1.7B-Base
https://huggingface.co/collections/LiquidAI/lfm3
https://huggingface.co/models?search=LiquidAI/LFM3-Omni-2B-MLX
https://huggingface.co/LiquidAI/LFM3-Omni-2B-MLX-8bit
https://huggingface.co/LiquidAI/LFM3-Omni-2B-MLX-bf16
https://huggingface.co/LiquidAI/LFM3-Omni-2B-MLX-4bit
https://huggingface.co/LiquidAI/LFM3-Omni-2B
https://huggingface.co/models?search=LiquidAI/d1-Omni-2B-MLX
https://huggingface.co/models?search=LiquidAI/LFM3-Audio-2B-MLX
https://huggingface.co/models?search=LiquidAI/LFM3-VL-2B-MLX
https://huggingface.co/models?search=LiquidAI/LFM3-1.7B-MLX
https://huggingface.co/srv-sngh/Ornith-9B-mlx-nvfp4

(duplicate lines in the paste are listed once here.)

## Notes recorded at intake (not decisions)

- The USER cap is "smaller than 2B parameters"; most of the pasted repos are 3B or larger. Under the cap in the list: LFM3-1.7B and its MLX builds. The list is "for example", so it is a pool to choose from, not a must-ship list.
- Download gate as stated: only when HUGGINGFACE_API_TOKEN is set, and only on demand after the remote models fail.
- Design is pending: a proposal, advisor consult and review come before any code (turn protocol).

## Approval log

- 2026-10-27T23:45:22+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## USER decisions

- 2026-10-27 (verbatim): "you can try also those of 3B parameters" — the local fallback size cap rises from under 2B to 3B parameters, so Nanbeige4.2-3B and its MLX builds and LiquidAI d1-3B are now candidates beside LFM3-1.7B.
- 2026-10-27 (verbatim): "you must use krill for nanbeinge4.2" — Nanbeige4.2 runs through Krill (https://github.com/srvsngh99/Krill), not through a generic MLX or Ollama runner. Krill itself is not yet researched.
USER directive verbatim (2026-10-28, repeating the /goal with one addition): "since we are using Locals for all mlx models, you can drop the support for kiril." Consequence: Krill support is removed from llm-ext; every MLX model (including Nanbeige4.2 and Qwen3.5) runs through Locals; the earlier note that Nanbeige4.2 must run through Krill is superseded.
2026-11-13 USER (verbatim, /goal): "you crashed (actually it was a corruption in the transcript, but i cleared all) so you need to reconstruct what were you doing yourself. surely you had a goal, but i forgot what it was. one thing was certainly to finish all TRDDs and fix all issues. do a /ultimate-bug-scanner pass on all sources, to check if some code was corrupted. then investigate the latest files that were edited. the most recent problem was the local jev/decision models sometimes using more than one instance of the mlx-decision server, instead of reusing it to ensure only one system wide existed (since it weights 15gb). The other was the automatic fallback of all commands to local small language models using the two local inference tools we have added to llm-ext, like locale and lama.cpp. in general the plugin was working on becoming resistant to any remote service becoming unavailable to errors, network isolation or credisf exhaustion, by falling back to local model, but with a carefully managed use of local models modulated in realtime to keep the system responsive and to not saturate or exhaust ram, cpu cores, disk space, etc. with a smart monitoring deciding when executing or terminating the processes of the local inference tools according to the overall state of the system. continue working until such system is working without errors and the updated plugin is published and installed."
2026-11-13 consequence (advisor-reviewed): this goal is the ruling that lifts addendum 4 (profile-fallback.ts header, 2026-09-17) for SERVICE-LEVEL failure only (outage / no network / 402 credit exhaustion); a dead model inside a healthy service stays in-profile. Survey (reports_dev/sonnet-worker/20261113_180252+0100-local-fallback-survey.md): today NO general command falls back to local_llama/locals-mlx; only classify adopts the mlx-decision singleton. Design constraints for the new EHT: (1) ready-now or no fallback: engine binary present, model on disk, calibration record ok, else original error + one enable line, never a download or calibration on a failure path; (2) reuse the --profile <local> path through broker + governor, no new spawn/lease code; (3) respect the local input budget, refuse never truncate; (4) latch per run once switched; (5) same cause split as NO_LOCAL_RESCUE, request-specific 4xx never falls back; (6) never silent: answered-by label + one warning; (7) one function in chatCompletionWithProfileFallback (index.ts ~3543-3576) first, real tests (closed port, local 402 server, tiny-llamas), then ensemble, free-rotation, scouting, one commit each. Also read SWNIIFTF (--stop_on_errors, fallback default-on rule 2026-10-28) before designing.

## Open questions

2026-11-13 OPEN (raised by the C3 review of O93LFMF3): once the general remote-to-local fallback lands, local llama jobs will hold governor slots exactly when remote models are down, which is also when the decider escalates, so lease starvation of the decider becomes routine and the O93LFMF3 60 s fast-fail would then drop decisions routinely. Decide whether the decider gets a reserved governor slot or priority over long llama/Locals jobs; until then the O93LFMF3 lease memo is provisional.
