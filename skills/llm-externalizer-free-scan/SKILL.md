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

- LLM Externalizer MCP server running (auto-started by Claude Code plugin)
- OpenRouter API key set (`$OPENROUTER_API_KEY`)

## Instructions

Copy this checklist and track your progress:

1. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__discover` to verify service is online
2. [ ] Parse the user's prompt for:
   - **Folder path** — absolute path (starts with `/`), or use current working directory
   - **File extensions** — e.g. `.ts`, `.py` → pass as `extensions`
   - **Directories to skip** — e.g. "skip tests" → pass as `exclude_dirs`
   - **Instructions** — everything else becomes the LLM task prompt
3. [ ] Call `mcp__plugin_llm-externalizer_llm-externalizer__scan_folder` with:

```json
{
  "folder_path": "<parsed path or cwd>",
  "free": true,
  "use_gitignore": true,
  "extensions": "<if parsed from prompt>",
  "exclude_dirs": "<if parsed from prompt>",
  "instructions": "<parsed instructions or default: 'Audit for bugs, error handling gaps, security issues, and resource leaks. Reference function names.'>"
}
```

4. [ ] The tool returns one report path per file. List them for the user.
5. [ ] Read and summarize key findings.
6. [ ] Remind the user this is a low-quality free scan — suggest ensemble scan for thorough audit.

## Scanning `.md` files — special rules

`.md` files (agent / command / skill definitions, docs, README) are **excluded by default** from scans. The default audit rubric is a source-code audit; handing a .md file to it produces hallucinated findings or empty reports — wasted tokens either way.

To scan `.md` files, pass explicit `instructions` describing what to look for: stale references to renamed symbols/commands, hardcoded values that should be placeholders, TODO/FIXME triage, outdated API snippets, coverage of specific caveats — things only a semantic reader can do.

**Do NOT use this skill for structural validation of plugin files** — frontmatter schema, argument-hint consistency, skill description coverage, plugin.json conformance. Those are deterministic checks that belong to:

- `claude-plugin-validation` (CPV) — `cpv-validate-plugin`, `cpv-validate-skill`, `cpv-semantic-validation`
- `claude plugin validate .` — the authoritative Claude Code CLI validator
- Project-local validation scripts (AST / schema parsers)

A validator runs these in milliseconds and is reproducible. An LLM doing the same work is orders of magnitude more expensive, non-reproducible, and prone to hallucinated findings. (Doubly wasteful on the free Nemotron tier where quality is already degraded.)

## Output

One `.md` report per source file, saved in `reports_dev/llm_externalizer/`. Each report contains findings from the single free model. Report filenames include the source filename for easy identification.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| Service offline | MCP server not running | Restart Claude Code or run `/llm-externalizer:llm-externalizer-discover` |
| Auth error | `$OPENROUTER_API_KEY` not set | Set the env var in `.claude/settings.json` or shell profile |
| Empty response | Model timed out | May need simpler instructions or smaller files |
| No files found | Wrong path or all files gitignored | Check `folder_path` is correct and `use_gitignore` setting |

## Examples

```json
{"tool": "scan_folder", "folder_path": "/path/to/project/src",
 "free": true, "instructions": "Find security issues.",
 "use_gitignore": true}
```

```json
{"tool": "scan_folder", "folder_path": "/path/to/project",
 "free": true, "extensions": [".py"],
 "instructions": "Find TODO comments and classify by urgency."}
```

## Resources

- [Tool reference](references/tool-reference.md)
  - Read-only analysis tools, Utility tools, Standard Input Fields
  - Advanced Parameters, File Grouping, Critical Constraints, Safety Features
- [Usage patterns](references/usage-patterns.md)
  - Scan a codebase for issues, Analyze multiple files together
  - Apply same check to each file independently
  - Compare two file versions, Compare files in batch mode, Compare files via git diff
  - Check for broken code references, Check for broken file imports
  - Reuse instructions across operations, Simple task with ensemble off
  - Quick factual answer, Code review with persona
  - Scan folder with gitignore + excluded dirs, Use folder_path on any tool
  - Redact custom patterns, Check source against specification
  - Check entire folder against specification, Grouped file processing, Code-optimized analysis
