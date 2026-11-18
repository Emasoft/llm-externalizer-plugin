---
trdd-id: R7NKAJ5B
title: Local model catalog with role, runtime, inputs and abliterated metadata
column: todo
status: tasked
created: 2026-11-18T05:18:16+0100
updated: 2026-11-18T06:17:21+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: feature
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:16+0100
---

# Local model catalog with role, runtime, inputs and abliterated metadata

Add a catalog with one entry per local model: exact id, repo, runtime (llama.cpp, mlx, mlx-decision), role (chat, decider, speech), inputs, mmproj file, abliterated flag, sizes from the HF API, verified-here flag with how, and the reason where llm-ext cannot run it. Entries cover the six current built-in models and the eight repos of the parent. Add a test that the built-in profiles use only catalog chat entries of the right runtime, and check the docs table in skills/llm-externalizer-cli-reference/references/models-and-settings.md against the catalog. No fallback behaviour changes. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes

2026-11-18T06:17:18+0100 Correction of commit 29571723: its message says the twelve entries other than the head and the decider stay null because no dated check of them exists. Five of them have one: the six-model smoke of 2026-10-28 (servers started directly, outside llm-ext) and llm-ext models calibrate Phase A PASS on 2026-10-29, and for the LFM3 MLX build a full calibration that finished on 2026-11-15 (status ok, fill tokens 0 for every kind). It is the only calibration record in that machine's calibration folder, for any runtime. Sources: reports/locals-mlx/20261028_200451+0100-six-model-smoke.md and reports/llama-cpp-profile/20261029_065416+0100-p6b-4-phase-a-six-models.md in the main checkout, which no branch of this repository has ever tracked (git log --all shows no commit for either path), and the calibration record on the machine that ran it. The catalog records these checks from the commit that adds this note. No dated check was found for the VL, Omni, Audio, abliter8 and mizahnyx GGUFs or for sergolsub/mlx-elephant-v1-9B; baselabs/elephant-1 stays open (the served decider answers as elephant-1, but which weights it runs is not established). Search: reports_dev/r7nkaj5b/20261118_060622+0100-dated-checks.md (worktree).
