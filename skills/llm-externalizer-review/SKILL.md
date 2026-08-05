---
name: llm-externalizer-review
description: |-
  Use when reviewing code with THIS agent's own model at $0 external spend —
  llm-ext plans the review (files + rubric, no LLM call), the agent reviews.
  Trigger with "delegate review", "review with your own model", "zero-cost review",
  "review plan", "host-agent review".
argument-hint: "[folder-path | file ...] [extra instructions]"
effort: medium
allowed-tools: Bash, Read, Grep, Write
---

# LLM Externalizer — Delegate Review ($0, host-agent mode)

`llm-ext review-plan` emits the deterministic scaffolding — resolved file set
(gitignore-aware, same walker as scan-folder), the real-defects-only rubric, and
a per-file protocol — **without calling any LLM**. YOU are the reviewer.

Measured during development (2026-08-05, planted-ground-truth evaluation): this
workflow was the only configuration that found the planted bug — at $0 — while
driven-LLM reviews found nothing at up to $0.55/run.

## Instructions

1. Parse `$ARGUMENTS` into a target (folder or file list) and optional extra
   instructions.
2. Run the plan (zero sends, ~1s):
   ```bash
   "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" review-plan --folder_path <target> \
     --use_gitignore true [--instructions "<extra>"]
   ```
   (Explicit files: `--input_files_paths <a> <b> …` instead of `--folder_path`.
   Reviewing recent changes: `--diff_workspace true`, `--diff_from <ref> --diff_to <ref>`,
   or `--diff_commit <sha>` — the plan then EMBEDS the per-file hunks with
   enclosing-function context, so you review the changes and open full files
   only when a hunk demands it.)
3. Follow the plan's protocol EXACTLY: read each listed file IN FULL, apply the
   rubric, and verify every candidate finding against the actual code before
   reporting it — a claim refutable by three lines of context is worse than none.
4. Write the findings report to the directory the plan names, timestamped
   `$(date +%Y%m%d_%H%M%S%z)-review-<slug>.md`, findings ranked by severity, each
   with file:line and a concrete failure scenario.
5. Reply with the report path and a one-line verdict count — never the full
   findings inline.

## Error handling

| Error | Fix |
|-------|-----|
| `review_plan: folder_path not found` | Check the target path |
| `zero files` | Extension/gitignore filters excluded everything — loosen them |
| Command not found | Verify `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext` exists |

## Notes

- $0 and no API key by construction — the plan never touches the network.
- For an external-LLM review instead (ensemble, free pool), use
  `/llm-externalizer-scan`; in paid mode estimate first with `--estimate`.
