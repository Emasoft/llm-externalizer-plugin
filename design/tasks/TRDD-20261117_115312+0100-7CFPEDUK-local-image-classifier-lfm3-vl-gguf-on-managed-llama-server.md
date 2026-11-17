---
trdd-id: 7CFPEDUK
title: Local image classifier, LFM3-VL GGUF on managed llama-server
column: backburner
status: tasked
created: 2026-11-17T11:53:12+0100
updated: 2026-11-17T11:53:12+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-17T11:53:12+0100
---

# Local image classifier, LFM3-VL GGUF on managed llama-server

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-11-17
- NEXT ACTION: step 1 spike on the CACHED LiquidAI pair (no download). Report: reports_dev/vision-spike/20261117-spike.md.
- OPEN USER DECISION: the user listed two abliterated repos among the preferred GGUFs (abliter8-ai/lfm3-2b-vl-abliter8-gguf, mizahnyx/lfm3-omni-2b-abliterated-heretic-v2-GGUF). The main agent proposes not to use them (a classifier gains nothing from removed refusals; no image-accuracy data for the altered weights). Not decided until the user answers.

## Why
USER 2026-11-17 (verbatim): "what? no screenshots? the elephant-1 model accepts only text input? then use a local liquidai model for images." and "i noticed that the mlx converted versions of liquidai models are often slower than the guf (llama.cpp) versions. So prefer the followings:" (AtomicChat/LFM3-VL-2B-GGUF among them), and "remember to keep the model in the huggingface cache dir, that is symlinked to my ssd drive". llm-ext 14.6.0 has no image input (grep image_url in scripts/llm-ext/src: 0 hits).

## Model
- Spike model (cached): LiquidAI/LFM3-VL-2B-GGUF, LFM3-VL-2B-Q4_K_M.gguf + mmproj-LFM3-VL-2B-Q8_0.gguf.
- Target model (preferred by the user's list): AtomicChat/LFM3-VL-2B-GGUF, LFM3-VL-2B-AD-Q4_K_M.gguf (1079.8 MB) + mmproj-LFM3-VL-2B-F16.gguf (361.4 MB), via `hf download` into ~/.cache/huggingface/hub (symlink to /Volumes/EmaUITEK4TBSSD/AIModels/huggingface/hub). Download only after the spike passes.
- Not chosen: Omni (mmproj 905.8 MB, audio unused); IQ3 rungs (VL card: "research-grade", model "fairly quantization-sensitive"); elephant-1 via mlx-decision (user prefers LiquidAI GGUF). Research: reports_dev/cheap-worker/20261117_121500+0100-atomicchat-lfm3-gguf.md, 20261117_113500+0100-mlx-decision-image-support.md.

## Steps
1. SPIKE (NPT, gates all code). Managed nothing, repo untouched. Start llama-server with the cached pair on a free port; requests with image_url data-URI parts and a JSON-schema response_format. Cases: 2 single-image yes, 2 single-image no, 1 two-image match (screenshot vs mockup) yes, 1 two-image mismatch no, 1 malformed PNG, 1 oversize image; A/B of --reasoning off vs the default (auto) on one case. Pass = valid JSON on every answered case, 6/6 answers right, malformed case fails cleanly. Fail = stop and report to the user. Settles: does build 11960 load LFM3-VL (today a string match only); is response_format honoured with images; is --reasoning off needed (INFERRED, the VL card is silent).
2. Image input: collectInputs accepts .png/.jpg/.jpeg/.webp as images with a size cap; today isBinary refuses them (scripts/llm-ext/src/classifiers/l2/inputs.ts:158, :183, :346).
3. Managed server: buildServerArgv passes --mmproj when the profile model has an mmproj field (scripts/llm-ext/src/local-llama-server.ts:111-136; grep mmproj there: 0 hits); --reasoning only if the spike shows it is needed.
4. Request: the local completion body carries images as image_url parts.
5. Command: image mode for the classifier commands, plus a design-adherence check (screenshot + mockup + rubric questions; yes/no + score per question). Exact command names mapped from the CLI before coding.

## Derived tasks (EHT)
- Calibration gating: managed local profiles hold a model's requests until calibrated, which can take hours. Trace whether a VL model on local_llama triggers calibration and whether it blocks the first image request; the calibration Sender is text-only (scripts/llm-ext/src/calibration/phase-a.ts:265-267).
- Image tokens enter the local input budget.
- One focused test file per step; the CLI-reference skill and the CHANGELOG updated.

## Approval log

- 2026-11-17T11:53:12+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
