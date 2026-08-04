---
trdd-id: 3JQVBO7M
title: Layered per-path review rules — project and user rulefiles with precedence
column: todo
created: 2026-08-05T00:06:05+0200
updated: 2026-08-05T00:06:05+0200
current-owner: llm-externalizer-session
task-type: feature
---

# Layered per-path rules engine (distilled from OpenCodeReview, NOT vendored)

## What

Replace the single flat `--instructions` string with layered, per-path rule
resolution: `--rules <path>` (highest) → `<repo>/.llm-ext/rules.yaml` (project) →
`~/.llm-externalizer/rules.yaml` (user, OPT-IN) → built-in default rubric (lowest).
Rules are `{path-glob, rule-text}` entries, first match wins, declaration order;
missing layers silently skipped. `--instructions` stays and APPENDS to the resolved
rule (never replaced — backward compatible).

## Why (evidence)

OCR's React default pack applied to our Node CLI backend manufactured the null-check
false-positive class (reports/open-code-review-eval/20260804_220900+0200-…md).
A rubric that matches the codebase is a first-order precision factor; per-path
scoping lets tests, generated code, and hot paths carry different rubrics.

## Constraints (USER 2026-08-04)

YAML opt-in (works with ZERO rulefiles — the built-in rubric is the Auto-DUBC
default), no UI, crossplatform globs (picomatch-style, case-insensitive on
mac/Windows), and a `rules-check <path>` debug command (two-surface rule).

## Acceptance

- [ ] resolution order exactly as above, first-match-wins, unit-tested
- [ ] `llm-ext rules-check src/x.ts` prints which layer+entry applies (no LLM)
- [ ] scan/code-task/review tools consume the resolved rule; estimator counts it
- [ ] ships a built-in default rubric equal to today's behavior (no regression)
