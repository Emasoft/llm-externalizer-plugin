---
trdd-id: 4AKLHLB4
title: Add the LFM3 GGUF and elephant-1 local models to the supported list and to every profile fallback chain
column: todo
status: tasked
created: 2026-11-17T12:02:14+0100
updated: 2026-11-17T12:24:02+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T12:02:14+0100
---

# Add the LFM3 GGUF and elephant-1 local models to the supported list and to every profile fallback chain

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-17
- NEXT ACTION: two read-only research reports, then a design section here: (a) model cards of the 8 repos -> reports_dev/local-models/20261117-model-cards.md; (b) where llm-ext keeps its supported local model list, the per-profile fallback chains and the classifier (decider) model -> reports_dev/local-models/20261117-code-map.md.
- Related: TRDD-7CFPEDUK (local image classifier). The elephant-1 MLX quant with image input changes its model choice; decide after report (a).

## Why
USER 2026-11-17 (verbatim): "maybe i was wrong about elephant-1 (`https://huggingface.co/baselabs/elephant-1`) not accepting images. this mlx quantization of elephant-1 accepts images for exmple, add it to the models options:
https://huggingface.co/sergolsub/mlx-elephant-v1-9B
read their model cards and add all the local models to the list of llm-externalizer supported local models and as fallbacks in all profiles (distinguish the classifier ones from the normal models when doing fallbacks):"
followed (paraphrase of the list, URLs exact in the user message) by baselabs/elephant-1, sergolsub/mlx-elephant-v1-9B, and pasted: AtomicChat/LFM3-1.7B-Uncensored-GGUF, AtomicChat/LFM3-Omni-2B-GGUF, AtomicChat/LFM3-Audio-2B-GGUF, AtomicChat/LFM3-VL-2B-GGUF, abliter8-ai/lfm3-2b-vl-abliter8-gguf, mizahnyx/lfm3-omni-2b-abliterated-heretic-v2-GGUF.
Earlier the same day: "prefer the followings" (GGUF over MLX for LiquidAI models) and "keep the model in the huggingface cache dir, that is symlinked to my ssd drive".

## Scope
1. Every listed model enters llm-ext's supported local model list, with runtime (llama.cpp GGUF or MLX), inputs (text, image, audio) and role (classifier/decider or normal chat model).
2. Every profile gets local fallbacks: classifier models only in the classifier (decider) fallback chain, normal models only in the chat/completion fallback chain.
3. Models stay in the Hugging Face cache (~/.cache/huggingface/hub, symlink to the SSD).

## Derived tasks (EHT)
- Calibration: managed local models are calibrated on first use (hours); adding many models must not trigger calibration of all of them at once.
- Model ids and files pinned from the repo trees, not typed by hand.
- Tests for the new list entries and fallback routing; CLI-reference skill and CHANGELOG.
- Downloads (proposed by the main agent, not a user requirement): the 8 whole repos total 71.2 GiB with every quant (measured 2026-11-17 from the HF tree API; elephant-1 alone 17.55 GiB); one quant per repo is far less; nothing is fetched without the user seeing the size first, and only into ~/.cache/huggingface/hub.
- Absent models (proposed; OPEN: conflicts with the user fail-fast rule, user to decide skip-with-note vs exit with an error): a fallback entry whose model is not cached, or an MLX entry on a non-Mac host, is skipped with a visible note, never a silent download or a hard failure.
- Remote profiles (proposed, user may veto): a local fallback entry never triggers an implicit download; it is used only when the model is already cached and its server can start.
- Classifier vs chat chains: each list entry carries its role; the decider chain reads only classifier entries, the completion chain only chat entries.
- Moved from TRDD-7CFPEDUK (2026-11-17): image input for the GGUF chat models (LFM3-VL, LFM3-Omni, abliter8 VL, mizahnyx Omni) needs --mmproj in buildServerArgv (local-llama-server.ts:111-136, 0 hits for mmproj today) and image_url parts in the local completion body (0 hits for image_url in src).
- Abliterated repos: AtomicChat/LFM3-1.7B-Uncensored-GGUF, abliter8-ai/lfm3-2b-vl-abliter8-gguf and mizahnyx/lfm3-omni-2b-abliterated-heretic-v2-GGUF have refusals removed; the mizahnyx card says it will comply with harmful requests. Mark them in the list; whether any becomes a DEFAULT fallback in a profile is an open user decision.

## Approval log

- 2026-11-17T12:02:14+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
