---
trdd-id: 4W3Q2B4S
title: llamaModelOnDisk misses a model in a snapshot subdirectory and trusts a cached file the online listing would not pick
column: todo
status: tasked
created: 2026-11-18T06:08:16+0100
updated: 2026-11-18T06:08:16+0100
current-owner: main-agent@llm-externalizer-plugin
created-by: main-agent@llm-externalizer-plugin
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@llm-externalizer-plugin
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@llm-externalizer-plugin
approval-datetime: 2026-11-18T06:08:16+0100
---

# llamaModelOnDisk misses a model in a snapshot subdirectory and trusts a cached file the online listing would not pick

Derived from TRDD-GNKO7WZS (archived), whose Notes list these two gaps as not closed by commit 8e093733.

1. Snapshot subdirectory. llamaModelOnDisk reads only the top level of the Hugging Face snapshot folder (readdirSync of the snapshot), so a repo that keeps its GGUF files in a subdirectory looks absent: a false "not ready", and the network give-up path treats a cached model as missing.
2. Online listing first match. llama.cpp (find_best_model at 8642541b2) picks the first file of the online repo listing that matches the quant. If the cache holds a different matching file than that first match, llama-server downloads the other one, so llm-ext reports ready for a model that still needs a download: a false "ready".

Fix: for 1, walk the snapshot recursively with the same file rules; for 2, decide which file llama.cpp would pick without a network call (or record that it cannot be decided offline) and test both cases in network-give-up.test.ts.

## Acceptance

- [ ] A repo:quant whose GGUF sits in a snapshot subdirectory counts as on disk (test).
- [ ] The second case is fixed with a test, or the card records why it cannot be decided offline.

## Approval log

- 2026-11-18T06:08:16+0100 — MANDATE issued by main-agent@llm-externalizer-plugin (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
