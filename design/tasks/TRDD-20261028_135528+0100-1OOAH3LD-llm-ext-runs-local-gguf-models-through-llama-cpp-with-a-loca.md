---
trdd-id: 1OOAH3LD
title: llm-ext runs local GGUF models through llama.cpp with a local_llama profile
column: design
status: tasked
created: 2026-10-28T13:55:28+0100
updated: 2026-10-28T14:29:09+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-10-28T13:55:28+0100
---

# llm-ext runs local GGUF models through llama.cpp with a local_llama profile

## User directive (verbatim, 2026-10-28)

> you should add the ability of llm-ext to use llama.cpp to execute any local model compatible with llama.cpp. in particular i need you to add a local profile called local_llama:
> ```
> # The local_llama profile will run llama.cpp locally as inference engine, with any llama.cpp compatible model.
> # WARNING: You need a llama.cpp build with LFM3 support (merged in llama.cpp #31252; produced at llama.cpp 19cce69).
> # The first model added to the profile is `AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K`.
> # The profile must automatically download it from huggingface or using the llama-cli command to download it,
> # cache it automatically, and run it, like this:
> llama-cli -hf AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6 -p "The prompt content goes here."
> ```

## Open points before design
- The directive names the quant as `AD-Q6_K` in one line and `AD-Q6` in the command line; the real tag must be checked on Hugging Face.
- Related: TRDD-UT7UC025 (self-healing profiles; Nanbeige4.2 must run through Krill).

## Approval log

- 2026-10-28T13:55:28+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## User decisions 2026-10-28

Q: how should llm-ext run the model (llama-cli per prompt reloads the 1.6 GB model each time; llm-ext sends prompts in parallel)? USER answer verbatim: "llama-server (Recommended)"
Q: after llm-ext starts llama-server, what happens when the command finishes? USER answer verbatim: "Keep it running (Recommended)" - llm-ext records the server process id and adds a command to stop it.
Q: installed llama.cpp 0.5.0 (build 11146) and Homebrew stable 0.7.0 both predate LFM3 support (PR 31252, commit 19cce69, merged 2026-10-27); only v0.8.0 (2026-10-28) has it. How to get a build? USER answer verbatim: "Brew HEAD build (Recommended)"
Model tag: use AD-Q6_K (exact file LFM3-1.7B-Uncensored-AD-Q6_K.gguf, 1587969920 bytes); the directive's AD-Q6 spelling is untested. Facts report: reports/llama-cpp-profile/20261028_135624+0100-facts.md
USER directive verbatim (2026-10-28): "notice that the model LFM3-1.7B is reported as having a context memory of 256k tokens. so make sure to split the input files accordingly (if i remember the benchmarks reported errors above 35-40% of the context, so test it well)"
Consequence: the design must (a) verify the 256k claim from the model config, (b) start llama-server with an explicit context size, and (c) measure answer quality at increasing context fill (for example 10, 20, 30, 35, 40, 50 percent of the window) and set the input-split size from the measured safe fill, not from the nominal 256k.
Smoke test 2026-10-28: Homebrew HEAD build b11960-8642541b2 (22 commits after LFM3 merge 19cce69) loaded AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K via llama-cli -hf and answered at about 107 tokens/s; the model emits a thinking block before the answer, which llm-ext must strip.
USER directive verbatim (2026-10-28): "notice that you can enable thinking for the model, and set the effort to various levels, each one increasing the model output and the context usage. so for complex tasks like finding bugs, you may want to limit the prompt to 30% but use effort=high, or effort=max, for example."
Consequence: the context budget per request is prompt + thinking + answer; the design maps each llm-ext command to a thinking effort level and measures, per effort level, the largest prompt fill (percent of the window) that still answers correctly, so heavier commands such as bug-finding get a smaller prompt share and a higher effort. Note: the llama.cpp LFM3.jinja template (b11960) exposes enable_thinking and preserve_thinking but no effort parameter; how effort is set must be verified from the model card or the GGUF embedded template.
USER directive verbatim (2026-10-28): "looks like the reasoning effort is simply determined by the amount of tokens and output tokens available. so we can just disable it for simple tasks, like text esiting, and enabling for bug search. always keeping the context usage under 30-40%"
Consequence: no effort-level table; each llm-ext command gets thinking off (simple tasks such as text editing) or on (bug search), and the thinking room is whatever token budget remains; prompt plus thinking plus answer stays under 30-40 percent of the context window (exact value from the context-fill benchmark).
Liquid AI docs pasted by the user (docs.liquid.ai LFM3-1.7B page): 1.73B params, 256K context input+output, 24 layers (13 short conv, 5 sliding-window attention, 6 global attention); general generation temperature 0.1, top_k 50, repetition_penalty 1.1; math and science temperature 1.0, top_p 0.95, top_k 20, repetition_penalty 1.0; reasoning on by default, enable_thinking False for direct answers; the page says it is NOT recommended for agentic coding or complex multi-step reasoning due to its size, so bug-search quality must be measured, not assumed.
