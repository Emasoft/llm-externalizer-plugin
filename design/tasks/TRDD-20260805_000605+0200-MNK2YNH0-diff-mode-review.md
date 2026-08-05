---
trdd-id: MNK2YNH0
title: Diff-mode review — workspace, range, commit scoping for every review tool
column: complete
created: 2026-08-05T00:06:05+0200
updated: 2026-08-05T16:20:00+0200
current-owner: llm-externalizer-session
task-type: feature
---

# Diff-mode review (distilled from OpenCodeReview, NOT vendored)

## What

llm-ext today reviews WHOLE FILES only. Add diff scoping as input selection for the
review tools: `--diff_workspace` (staged+unstaged+untracked), `--diff_from/--diff_to`
(range, merge-base), `--diff_commit`. The tool sends hunks + enclosing-function
context instead of full files — smaller inputs are cheaper on paid models and are
precisely what weak free models need (three-way test showed input size is a
first-order quality factor for them).

## Constraints (USER 2026-08-04)

Auto-DUBC (git detection automatic; absent git → clear fail-fast, never a guess),
no UI, opt-in YAML for fine-tuning (context lines, merge-base behavior),
crossplatform (git plumbing via child_process, no shell pipelines that break on WSL).

## Acceptance

- [x] scan_folder/high_quality_scan/code_task/review_plan accept diff args; resolution delegated to git (name-only + per-file hunks); --estimate/--preview understand them via the shared resolver (a3f03ae)
- [x] hunk context includes the enclosing function via git's own --function-context (better than the planned brace heuristic: git's xfuncname machinery, zero new dependencies)
- [x] tests: real fixture repo (git init) covering workspace/commit/range, untracked, binary + 400KB-cap skips, zero-diff and non-repo fail-fast
