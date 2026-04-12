---
name: llm-externalizer-scan
description: |-
  Use when scanning an entire project or codebase for bugs, security issues, or code quality problems.
  Trigger with "scan project", "audit codebase", "scan codebase", "full scan",
  "run project scan", "check whole project", "scan all files".
argument-hint: "[folder-path | . | glob-pattern] [focus: bugs|security|all]"
effort: medium
context: fork
agent: llm-ext-reviewer
---

Scan the target specified in $ARGUMENTS using the LLM Externalizer ensemble and return ONLY report file paths. This skill runs in an isolated subagent context — scan output stays out of the orchestrator's context window.

## Task

1. If $ARGUMENTS is empty, treat the target as `.` (the current working directory).
2. If $ARGUMENTS contains a folder path, scan that folder with the default review rubric (logic bugs, error handling gaps, security issues, resource leaks, broken references).
3. If $ARGUMENTS contains a glob or list of files, scan those specific files.
4. If $ARGUMENTS includes a focus hint (e.g. "security", "bugs only", "spec compliance"), narrow the review rubric accordingly.
5. If $ARGUMENTS includes "free" or "quick" or "cheap", use the free Nemotron profile (`free: true`) — warn about prompt logging first.

Default tool selection:
- Folder or large file set → `mcp__llm-externalizer__scan_folder` with `use_gitignore: true`, `answer_mode: 0`
- ≤5 files → `mcp__llm-externalizer__code_task` with `answer_mode: 0`, `max_retries: 3`

Return format (exact):
```
[DONE] scan-<label> — <N> reports
<absolute-path-1>
<absolute-path-2>
...
```

On failure:
```
[FAILED] scan-<label> — <one-line reason>
```

## Prerequisites (verify before scanning)

- MCP service online (`mcp__llm-externalizer__discover`)
- For ensemble/remote: OpenRouter API key resolved (set via plugin userConfig OR `$OPENROUTER_API_KEY` shell env)
- For local backends: LM Studio / Ollama / vLLM listening on the configured port
