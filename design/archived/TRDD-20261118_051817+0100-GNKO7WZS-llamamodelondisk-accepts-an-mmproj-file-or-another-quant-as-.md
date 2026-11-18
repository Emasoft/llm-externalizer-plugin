---
trdd-id: GNKO7WZS
title: llamaModelOnDisk accepts an mmproj file or another quant as the model weights
column: complete
status: archived
created: 2026-11-18T05:18:17+0100
updated: 2026-11-18T06:05:25+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T05:18:17+0100
implementation-commits: [8e093733]
---

# llamaModelOnDisk accepts an mmproj file or another quant as the model weights

llamaModelOnDisk (network-give-up.ts:117-128) treats a repo:quant model as on disk when any .gguf file name in the snapshot contains the quant text, so an mmproj file (mmproj-...-Q8_0.gguf, mmproj-...-F16.gguf) or another quant (Q4_K matches Q4_K_M and Q4_K_S) can make an absent model look ready. Fix: match the LLM weight file (not mmproj) and the quant as a whole token; test both cases. Parent: TRDD-4AKLHLB4.

## Approval log

- 2026-11-18T05:18:17+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-11-18T06:05:25+0100 — COMPLETE by main-agent@llm-externalizer-plugin. fix 8e093733 landed and all four acceptance boxes are ticked; the work ran while the card stood in todo, so it skipped the dev, testing and ai_review columns.

## Notes

2026-11-18T05:44:49+0100 8e093733: the readiness check now mirrors find_best_model of llama.cpp 8642541b2 (the installed build): a .gguf file (case sensitive), basename without mmproj, mtp- or imatrix, the quant as a token with the left boundary (^|[-_./]), which is stricter than 8642541b2 and leaves only a false "not ready" for a quant glued to a letter. A split model counts only when shard 1 and all shards are cached: this goes beyond the text of this card, because at 8642541b2 the download plan takes every shard of the online listing (download.cpp:842, arg.cpp:529-541), so a missing shard is the same false ready. Tests: 14 repo:quant cases in network-give-up.test.ts; per the run of the worker, 7 of the first 12 were red before the fix and two mutation runs show the shard case and the upper-case .GGUF case each fail without their check; the main agent read the committed test diff (additive only, fixture defaults unchanged) and re-ran the single file (69/69, exit 0), tsc -p (0) and eslint (0); the pre-commit ubs scan of both files: 0 critical. Not closed: a vision repo with an uncached mmproj (recorded on TRDD-RS2MTVP7), a model in a snapshot subdirectory, and the first match of the online listing differing from the cached file. Evidence: reports_dev/gnko7wzs/20261118_052718+0100-quant-match.md (worktree).

## Acceptance

- [x] An mmproj projector never counts as the model weights (tests: mmproj Q8_0 only, mmproj F16 only: not ready).
- [x] The quant matches as a whole token (tests: Q4_K with only Q4_K_M, with Q4_K_S and a sharded Q4_K_M, Q4_0 with only IQ4_0: not ready; AD-Q6_K head, lower case, underscore-preceded: ready).
- [x] Both cases tested, red before the fix: 7 of the first 12 new cases failed on the old code (per the run of the worker); after 8e093733 the single file passes 69/69 (re-run by the main agent).
- [x] Beyond the card text: a split model counts only when shard 1 and all its shards are cached (test: shard 1 of 2 present, shard 2 missing: not ready; red without the check in a mutation run, per the run of the worker).
