---
name: llm-externalizer-scan
description: |-
  Full project scan using LLM Externalizer ensemble (3 models in parallel).
  Trigger with "scan project", "audit codebase", "scan codebase", "full scan",
  "run project scan", "check whole project", "scan all files".
version: 1.0.0
---

# LLM Externalizer — Full Project Scan

Run a comprehensive codebase scan using 3 ensemble models (Gemini 2.5 Flash + Grok 4.1 Fast + Qwen 3.6 Plus) in parallel.

## Instructions

1. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__discover` to verify service is online
2. [ ] Identify the project root directory (the folder containing the main source code)
3. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__scan_folder` with these parameters:

```
folder_path: "<absolute path to project root>"
instructions: "<brief project description>. Audit for: 1) Logic bugs and edge cases 2) Error handling gaps 3) Security issues 4) Resource leaks 5) Broken references. Be specific: reference function names."
use_gitignore: true
answer_mode: 2
```

4. [ ] Read the output report file path returned by the tool
5. [ ] Read the report with the Read tool
6. [ ] Summarize findings to the user, grouped by severity

## Parameters

| Parameter | When to use |
|-----------|------------|
| `extensions` | Filter to specific languages: `[".ts", ".py"]`. Omit to scan ALL text files |
| `exclude_dirs` | Skip additional directories beyond defaults (node_modules, .git, dist, etc. are always skipped) |
| `answer_mode` | `2` = one merged report (default, best for overview). `0` = per-file reports (better for large codebases) |
| `max_payload_kb` | Lower from 400 if models hallucinate on large batches |

## What gets scanned

By default (no `extensions` filter), ALL non-binary text files are included: `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.md`, `.json`, `.yaml`, `.toml`, `.xml`, `.html`, `.css`, `.sh`, `.sql`, and more.

## What gets excluded

Directories always excluded: `node_modules`, `.git`, `__pycache__`, `.venv`, `dist`, `build`, `.next`, `.nuxt`, `.idea`, `.vscode`, `tmp`, `vendor`, `coverage`, `target`, and more.

## Tips

- **Always include project context** in instructions — the LLM knows nothing about your project
- **Large projects** (>50 files): use `answer_mode: 0` for per-file reports, or filter with `extensions`
- **Sensitive code**: add `scan_secrets: true` to abort if API keys are detected before sending to LLM
- The scan uses adaptive rate limiting (auto-detected from OpenRouter balance) and heartbeat keepalive — no timeout risk even for large codebases
