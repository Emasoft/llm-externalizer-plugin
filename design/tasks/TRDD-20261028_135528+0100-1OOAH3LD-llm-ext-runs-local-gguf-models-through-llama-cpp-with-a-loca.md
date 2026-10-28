---
trdd-id: 1OOAH3LD
title: llm-ext runs local GGUF models through llama.cpp with a local_llama profile
column: design
status: tasked
created: 2026-10-28T13:55:28+0100
updated: 2026-10-28T14:00:01+0100
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
