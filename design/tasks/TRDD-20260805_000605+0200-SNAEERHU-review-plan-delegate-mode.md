---
trdd-id: SNAEERHU
title: review-plan — a $0 delegate mode where the host agent is the reviewer
column: complete
created: 2026-08-05T00:06:05+0200
updated: 2026-08-05T01:14:00+0200
current-owner: llm-externalizer-session
task-type: feature
---

# review-plan — delegate mode (distilled from OpenCodeReview, NOT vendored)

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-05

v1 LANDED (uncommitted at write time; commit follows this edit): catalog entry
`review_plan` (definitions.ts), dispatch case (index.ts, reuses the estimator's
resolver seam — one source of truth for the file set), pure builder
`src/review-plan.ts` + 5 unit tests, skill `llm-externalizer-review`, estimator
zero-cost entry, README counts 40→41 (doc-consistency gate green). Verified live:
0.42s, zero sends, rubric + appended instructions correct.

CLOSED 2026-08-05 01:14 (+0200), commit 9ae1258. No-settings boot path VERIFIED
in a throwaway HOME: default settings auto-generated (Auto-DUBC), exit 0. All
v1 acceptance met. Future integration points live on their OWN cards:
diff-args input → TRDD-MNK2YNH0; per-path rubric → TRDD-3JQVBO7M.

SUPERSEDED — do NOT carry forward: nothing.

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

- [x] `llm-ext review-plan [--folder_path|--input_files_paths]` prints a
      structured plan (files + rules + per-file framing) with ZERO network sends
      (diff args deferred to TRDD-MNK2YNH0 — noted in STATE)
- [x] skill `llm-externalizer-review` drives it: plan → host agent reviews → report
      in reports/llm-externalizer/ (two-surface rule)
- [x] works with no settings.yaml present (Auto-DUBC default path) — verified in
      a throwaway HOME: default settings auto-generated, exit 0
- [x] no UI, plain greppable stdout; crossplatform paths (no shell-isms)
