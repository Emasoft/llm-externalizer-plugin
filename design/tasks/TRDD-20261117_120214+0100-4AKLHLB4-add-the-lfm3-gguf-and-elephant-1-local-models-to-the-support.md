---
trdd-id: 4AKLHLB4
title: Add the LFM3 GGUF and elephant-1 local models to the supported list and to every profile fallback chain
column: todo
status: tasked
created: 2026-11-17T12:02:14+0100
updated: 2026-11-18T06:17:36+0100
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
eht: [R7NKAJ5B, C7ACDK79, GLK56Q6F, RS2MTVP7, GNKO7WZS]
---

# Add the LFM3 GGUF and elephant-1 local models to the supported list and to every profile fallback chain

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-18
- DONE 2026-11-18 (reports_dev/local-models/20261118_050033+0100-model-cards.md and 20261118_050018+0100-code-map.md): NEXT ACTION: two read-only research reports, then a design section here: (a) model cards of the 8 repos -> reports_dev/local-models/20261117-model-cards.md; (b) where llm-ext keeps its supported local model list, the per-profile fallback chains and the classifier (decider) model -> reports_dev/local-models/20261117-code-map.md.
- Related: TRDD-7CFPEDUK (local image classifier). Decided after report (a): image input belongs to C4 (TRDD-RS2MTVP7), with TRDD-7CFPEDUK as its first consumer; which weights the decider singleton serves is asked under C3 (TRDD-GLK56Q6F).
- 2026-11-18T05:18:31+0100 NEXT ACTION: work C1 and C5; C2 waits on TRDD-SZ7TO9FW; Q1-Q4 are with the USER.

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

## Design (2026-11-18, main agent)

Facts (from reports_dev/local-models/20261118_050033+0100-model-cards.md and 20261118_050018+0100-code-map.md, read by the main agent; sizes spot-checked against the HF API JSON):
- No local model registry exists. The supported local models are the model, second_model and third_model fields of the two built-in profiles local_llama and locals-mlx (config.ts:2237-2283). Those fields cap at three, fan out as a local ensemble on ensemble commands (index.ts:4579-4620), make the first command on the profile wait for every uncalibrated member (local-input-budget.ts:203-250, index.ts:5244-5260), and reach existing installs never, because the built-in profiles are added once (benchmark/pick.ts:2310-2395).
- The remote-to-local fallback uses only the head model of the first ready local profile, locals-mlx then local_llama (network-give-up.ts:152-177, index.ts:3754-3767). Ready means engine on PATH, head weights on disk, calibration record ok. A not-ready target is skipped with no line.
- The decider is adopt-only with one hard-coded model, SERVED_MODEL elephant-1 (classifiers/l2/local-decider.ts:37). The singleton at 127.0.0.1:8123 reported loaded [elephant-1] and described it as "served locally by mlx-decision" (curl /health and /v1/models, 2026-11-18). Which weights it runs (baselabs bf16 or an MLX quant) is not known here.
- No --mmproj and no image_url or audio content parts exist anywhere in scripts/llm-ext (grep).
- The local_llama head has been AtomicChat/LFM3-1.7B-Uncensored-GGUF:AD-Q6_K, an abliterated repo, since 452887a8 (2026-10-29), first released in 14.2.0.
Decisions (main agent, under the USER delegation of 2026-11-15; the USER may veto):
1. The profile fields are not the vehicle for the list. A separate catalog holds one entry per model: exact id, repo, runtime (llama.cpp, mlx, mlx-decision), role (chat, decider, speech), inputs, mmproj file, abliterated flag, sizes from the HF API, verified-here flag with how, and, where llm-ext cannot run it, the reason.
2. Listing a model never downloads or calibrates it. An entry is eligible for any fallback only when it is on disk and calibrated; an explicit `llm-ext models calibrate --model <id>` makes it eligible. This settles the download and calibrate-all-at-once derived tasks.
3. Fallback chains by role reuse the unwired seam of the profile contract, profiles/resolve-chain.ts and profiles/route-for-tier.ts (TRDD-SZ7TO9FW, USER-ordered), instead of a second chain mechanism.
4. Three of the eight repos cannot join a chat chain: baselabs/elephant-1 (CUDA-only safetensors with a vendor engine), sergolsub/mlx-elephant-v1-9B (vendor loader onejev_mlx.py; a decider, not a chat model), AtomicChat/LFM3-Audio-2B-GGUF (speech, ASR and TTS). They are listed with the reason.
5. Runtime support of the VL and Omni GGUFs and of the AD quants on stock llama.cpp rests on the model cards only (llama.cpp PRs 31252 and 31257). The current local_llama head was smoke-tested on 2026-10-28 (TRDD-1OOAH3LD: llama-cli -hf on llama.cpp b11960-8642541b2 loaded it and answered); commit 68ea6820 wrongly called that claim unsourced; its message names the design spec and the code-map and model-card reports as its sources, not the 1OOAH3LD card. The catalog of TRDD-R7NKAJ5B records that check; the five other models of the two built-in profiles were loaded and answered in a six-model smoke outside llm-ext on 2026-10-28 and passed Phase A of llm-ext models calibrate on 2026-10-29, which the catalog records too (commit e3ddf408 still called them not verified); of the other seven repos none is verified (the served decider answers as elephant-1, but which weights it runs is not established), and verifying them needs downloads.
6. Context length is not taken from GGUF headers: calibration owns it.
Split (each its own card, listed in this card eht so this card completes when they are terminal):
- C1 catalog (todo): the catalog with entries for the six current built-in models and the eight repos, its metadata, a test that the built-in profiles use only catalog chat entries of the right runtime, and the docs table in skills/llm-externalizer-cli-reference/references/models-and-settings.md checked against it. No fallback behaviour changes.
- C2 role-based fallback chains (backburner, waits on TRDD-SZ7TO9FW): the chat chain walks eligible catalog chat entries through resolve-chain and route-for-tier; never a not-eligible entry.
- C3 decider model set (backburner): SERVED_MODEL becomes the catalog decider entries and adoption accepts any of them; first ask the owner of the mlx-decision server which weights it serves and what its image request body is (classifiers/l0/local-transport.ts is unread).
- C4 vision input (backburner, with TRDD-7CFPEDUK as its first consumer): --mmproj in buildServerArgv (local-llama-server.ts:110-136), the mmproj file counted by readiness, estimate and fingerprint, and image_url parts in the local completion body.
- C5 bug (todo): llamaModelOnDisk (network-give-up.ts:117-128) treats a repo:quant model as on disk when any .gguf file name in the snapshot contains the quant text, so an mmproj file (mmproj-...-Q8_0.gguf, mmproj-...-F16.gguf) or another quant (Q4_K matches Q4_K_M and Q4_K_S) can make an absent model look ready. Fix: match the LLM weight file (not mmproj) and the quant as a whole token; test both cases.
Open USER questions (also listed in the session report):
- Q1 absent model: today a not-ready local fallback target is skipped with no line. Keep silent skip, print a note, or exit with an error (the fail-fast rule)?
- Q2 abliterated models: the local_llama head is already the uncensored LFM3 1.7B since 14.2.0. Keep it as the default fallback head, or switch the default to the non-abliterated LFM3 and keep abliterated ones opt-in?
- Q3 downloads to verify the VL and Omni GGUFs: smallest sensible sizes are 1,511,202,656 bytes (VL Q4_K_M plus F16 mmproj) and 2,082,051,040 bytes (Omni Q4_K_M plus F16 mmproj). Allowed?
- Q4 narrowing: three of the eight repos can not be chat fallbacks (decision 4). Accept?
Card ids: C1 = TRDD-R7NKAJ5B, C2 = TRDD-C7ACDK79, C3 = TRDD-GLK56Q6F, C4 = TRDD-RS2MTVP7, C5 = TRDD-GNKO7WZS.
