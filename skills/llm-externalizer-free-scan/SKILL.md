---
name: llm-externalizer-free-scan
description: |-
  Use when scanning a project for free using the Nemotron model (no cost, lower quality).
  Trigger with "free scan", "free-scan", "scan for free", "quick scan", "cheap scan",
  "scan without cost", "nemotron scan".
argument-hint: "[folder-path | .]"
effort: medium
---

# LLM Externalizer — Free Project Scan

## Overview

Run a project scan using the **free** NVIDIA Nemotron 3 Super model (`nvidia/nemotron-3-super-120b-a12b:free`). No cost, single model, 262K context.

**LOW QUALITY**: This model has significantly lower intelligence than the 3-model ensemble. Expect more false positives, missed bugs, and shallow analysis. Use only for quick rough checks on non-critical code.

**WARNING**: Prompts are logged by the provider — do not use with sensitive or proprietary code.

## Prerequisites

- `${CLAUDE_PLUGIN_ROOT}/bin/llm-ext` CLI available (no server process to start)
- OpenRouter API key set via plugin `userConfig.openrouter_api_key` (keychain) OR `$OPENROUTER_API_KEY` shell env

## Instructions

1. Run `llm-ext discover` to verify service online.
2. Parse prompt for **folder_path** (default cwd), **extensions**, **exclude_dirs**, **instructions** (default: report real bugs only — logic, crashes, security exploits, data corruption, functionality mismatch; not missing error handling/null checks/validation/logging; cite functions + lines; terse).
3. Run `llm-ext scan-folder --free --use_gitignore` plus parsed fields (`--folder_path`, `--extensions`, `--exclude_dirs`, `--instructions`). Scans over large folders can run long — use an extended Bash timeout or `run_in_background: true`.
4. Command returns one report path per file. List them for the user.
5. Remind user this is low-quality — suggest ensemble for thorough audit. Do NOT read/summarise reports.

Limitations: `.md` files EXCLUDED by default (pass `--instructions` for semantic search). LLM sees only 1–5 files/request — no cross-file refs (`check-against-specs` or `search-existing-implementations`).

## Output

One `.md` report per source file. Reports default to `<main-project-dir>/reports/llm-externalizer/` (the main project dir Claude Code is in); pass `--output_dir` only for a custom location. Report filenames include the source filename for easy identification.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Service offline | Backend unreachable | Run `/llm-externalizer:llm-externalizer-discover` or check network/API status |
| Auth error | OpenRouter key not set | Set plugin `userConfig.openrouter_api_key` (keychain) or export `$OPENROUTER_API_KEY` in your shell profile |
| Empty response | Model timed out | May need simpler instructions or smaller files |
| No files found | Wrong path or all files gitignored | Check `--folder_path` is correct and `--use_gitignore` setting |

## Examples

```bash
llm-ext scan-folder --folder_path /path/to/project/src \
  --free --instructions "Find security issues." --use_gitignore
```

```bash
llm-ext scan-folder --folder_path /path/to/project \
  --free --extensions '[".py"]' \
  --instructions "Find TODO comments and classify by urgency."
```

## Resources

- [Tool reference](references/tool-reference.md)
  - Read-only analysis tools, Utility tools, Standard Input Fields
  - Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md)
  - Scan a codebase for issues, Analyze multiple files in parallel
  - Apply same check to each file independently
  - Compare two file versions (pair mode), Compare files in batch mode
  - Compare files via git diff
  - Check for broken code references after refactoring, Check for broken file imports
  - Reuse instructions across operations, Simple task with ensemble off (save tokens)
  - Quick factual answer with low max_tokens, Code review with persona
  - Scan folder with gitignore + excluded dirs, Use folder_path on any tool
  - Redact custom patterns, Check source against specification
  - Check entire folder against specification
  - Grouped file processing (isolated reports), Code-optimized analysis
