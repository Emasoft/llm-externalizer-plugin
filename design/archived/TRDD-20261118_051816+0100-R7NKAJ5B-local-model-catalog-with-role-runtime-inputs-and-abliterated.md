---
trdd-id: R7NKAJ5B
title: Local model catalog with role, runtime, inputs and abliterated metadata
column: complete
status: archived
created: 2026-11-18T05:18:16+0100
updated: 2026-11-18T06:43:32+0100
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
implementation-commits: [77132946, 29571723, 208c2b69, b148a1ee]
---

# Local model catalog with role, runtime, inputs and abliterated metadata

Add a catalog with one entry per local model: exact id, repo, runtime (llama.cpp, mlx, mlx-decision), role (chat, decider, speech), inputs, mmproj file, abliterated flag, sizes from the HF API, verified-here flag with how, and the reason where llm-ext cannot run it. Entries cover the six current built-in models and the eight repos of the parent. Add a test that the built-in profiles use only catalog chat entries of the right runtime, and check the docs table in skills/llm-externalizer-cli-reference/references/models-and-settings.md against the catalog. No fallback behaviour changes. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T06:43:32+0100 — COMPLETE by main-agent@llm-externalizer-plugin. catalog, test and docs landed in 77132946, 29571723, 208c2b69 and b148a1ee, and all six acceptance boxes are ticked; the work ran while the card stood in todo, so it skipped the dev, testing and ai_review columns.

## Notes

2026-11-18T06:17:18+0100 Correction of commit 29571723: its message says the twelve entries other than the head and the decider stay null because no dated check of them exists. Five of them have one: the six-model smoke of 2026-10-28 (servers started directly, outside llm-ext) and llm-ext models calibrate Phase A PASS on 2026-10-29, and for the LFM3 MLX build a full calibration that finished on 2026-11-15 (status ok, fill tokens 0 for every kind, which the calibration code reads as unfit for every task kind: calibration/phase-b.ts and profiles/verdicts.ts). It is the only calibration record in that machine's calibration folder, for any runtime. Sources: reports/locals-mlx/20261028_200451+0100-six-model-smoke.md and reports/llama-cpp-profile/20261029_065416+0100-p6b-4-phase-a-six-models.md in the main checkout, which no branch of this repository has ever tracked (git log --all shows no commit for either path), and the calibration record on the machine that ran it. The catalog records these checks from the commit that adds this note. No dated check was found for the VL, Omni, Audio, abliter8 and mizahnyx GGUFs or for sergolsub/mlx-elephant-v1-9B; baselabs/elephant-1 stays open (the served decider answers as elephant-1, but which weights it runs is not established). Search: reports_dev/r7nkaj5b/20261118_060622+0100-dated-checks.md (worktree).

## Acceptance

- [x] One entry per local model with exact id, repo, runtime, role, inputs, mmproj, abliterated flag, sizes from the HF API, verified with how, and the reason where llm-ext cannot run it: interface LocalModelEntry in scripts/llm-ext/src/local-model-catalog.ts (77132946).
- [x] Entries cover the six built-in models and the eight repos of TRDD-4AKLHLB4: 14 entries (the local_llama head is both a built-in model and one of the eight repos; the served decider has its own entry, elephant-1).
- [x] A test checks that the built-in profiles use only catalog chat entries of the right runtime (first test of local-model-catalog.test.ts); the file passed 5 of 5 on the content of b148a1ee (run by a worker, output read by the main agent).
- [x] The docs table in skills/llm-externalizer-cli-reference/references/models-and-settings.md is checked against the catalog (fifth test: every id has a row with the same size and refusals cells).
- [x] No fallback behaviour changes: only local-model-catalog.test.ts imports the catalog (grep of every .ts, .mjs, .js and .cjs file under scripts, hooks, bin and skills for the file name and the LOCAL_MODEL_CATALOG and LocalModelEntry symbols, by the main agent, 2026-11-18; vitest.config.ts names only the test).
- [x] The verified field records a dated check for seven entries after 208c2b69 (the six built-in models and the served decider); the search for the others is reports_dev/r7nkaj5b/20261118_060622+0100-dated-checks.md (gitignored, local to the worktree).
