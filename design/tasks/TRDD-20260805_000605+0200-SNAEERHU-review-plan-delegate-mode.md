---
trdd-id: SNAEERHU
title: review-plan — a $0 delegate mode where the host agent is the reviewer
column: todo
created: 2026-08-05T00:06:05+0200
updated: 2026-08-05T00:06:05+0200
current-owner: llm-externalizer-session
task-type: feature
---

# review-plan — delegate mode (distilled from OpenCodeReview, NOT vendored)

**USER directive (2026-08-04):** distill/absorb OCR's ideas, adapted to our rules —
no dashboards/UI, Auto-DUBC, YAML strictly opt-in, crossplatform (linux/macos/WSL,
CUDA + MLX autoconfig where local models are involved). Never copy-paste OCR code
(it is Go; ours is TS — concepts port, code does not).

## What

A new `llm-ext review-plan` tool: emit the deterministic scaffolding of a review —
resolved file set (same walker as scan_folder), per-path rules (TRDD-3JQVBO7M),
diff refs (TRDD-MNK2YNH0 when in diff mode), and suggested per-file checklists —
**without any LLM call**, so the HOST agent (Claude Code on subscription, or any
LLM) performs the reviewing. $0 external spend, no API key needed at all.

## Why (evidence)

Three-way test on the planted-TP range (reports/open-code-review-eval/
20260804_224500+0200-three-way-review-comparison.md): OCR delegate + subscription
Claude found the planted bug + one new real finding in ~4 min at $0; OCR's own LLM
half measured 0 real findings across 3 free-model runs. The deterministic half is
the valuable half — and it is the half llm-ext does not have.

## Acceptance

- [ ] `llm-ext review-plan [--folder_path|--input_files_paths|diff args]` prints a
      structured plan (files + rules + per-file framing) with ZERO network sends
- [ ] skill `llm-externalizer-review` drives it: plan → host agent reviews → report
      in reports/llm-externalizer/ (two-surface rule)
- [ ] works with no settings.yaml present (Auto-DUBC default path)
- [ ] no UI, plain greppable stdout; crossplatform paths (no shell-isms)
