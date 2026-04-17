# LLM Externalizer — Usage Patterns

## Table of Contents

- [Scan a codebase for issues](#scan-a-codebase-for-issues)
- [Analyze multiple files in parallel](#analyze-multiple-files-in-parallel)
- [Apply same check to each file independently](#apply-same-check-to-each-file-independently)
- [Compare two file versions (pair mode)](#compare-two-file-versions-pair-mode)
- [Compare files in batch mode](#compare-files-in-batch-mode)
- [Compare files via git diff](#compare-files-via-git-diff)
- [Check for broken code references](#check-for-broken-code-references-after-refactoring)
- [Check for broken file imports](#check-for-broken-file-imports)
- [Reuse instructions across operations](#reuse-instructions-across-operations)
- [Simple task with ensemble off](#simple-task-with-ensemble-off-save-tokens)
- [Quick factual answer](#quick-factual-answer-with-low-max_tokens)
- [Code review with persona](#code-review-with-persona)
- [Scan folder with gitignore](#scan-folder-with-gitignore--excluded-dirs)
- [Use folder_path on any tool](#use-folder_path-on-any-tool)
- [Redact custom patterns](#redact-custom-patterns)
- [Check source against specification](#check-source-against-specification)
- [Check entire folder against specification](#check-entire-folder-against-specification)
- [Grouped file processing](#grouped-file-processing-isolated-reports)
- [Code-optimized analysis](#code-optimized-analysis)

Concrete examples for every tool with recommended parameters.

## Scan a codebase for issues

```json
{
  "tool": "scan_folder",
  "folder_path": "/path/to/src",
  "extensions": [".ts", ".py"],
  "instructions": "Find security vulnerabilities. This is a Node.js REST API using Express."
}
```

## Analyze multiple files in parallel

```json
{
  "tool": "chat",
  "instructions": "Compare these configs and list differences",
  "input_files_paths": ["/path/a.yaml", "/path/b.yaml"]
}
```

## Apply same check to each file independently

> **Note**: `batch_check` is **deprecated**. Use any tool with `answer_mode: 0, max_retries: 3` instead.

```json
{
  "tool": "code_task",
  "answer_mode": 0,
  "max_retries": 3,
  "instructions": "Find all TODO comments and classify by urgency",
  "input_files_paths": ["/path/a.ts", "/path/b.ts", "/path/c.ts"]
}
```

## Compare two file versions (pair mode)

```json
{
  "tool": "compare_files",
  "input_files_paths": ["/path/old.ts", "/path/new.ts"],
  "instructions": "Focus on API breaking changes"
}
```

## Compare files in batch mode

Compare multiple file pairs at once using the `file_pairs` parameter:

```json
{
  "tool": "compare_files",
  "file_pairs": [
    ["/path/old/auth.ts", "/path/new/auth.ts"],
    ["/path/old/routes.ts", "/path/new/routes.ts"],
    ["/path/old/middleware.ts", "/path/new/middleware.ts"]
  ],
  "instructions": "Summarize changes in each pair. This is a Node.js Express API."
}
```

Supports `---GROUP:id---` markers as single-element entries in `file_pairs` for grouped reports:

```json
{
  "tool": "compare_files",
  "file_pairs": [
    ["---GROUP:auth---"],
    ["/path/old/auth.ts", "/path/new/auth.ts"],
    ["---/GROUP:auth---"],
    ["---GROUP:api---"],
    ["/path/old/routes.ts", "/path/new/routes.ts"],
    ["---/GROUP:api---"]
  ],
  "instructions": "Summarize changes per group"
}
```

## Compare files via git diff

Compare files between two git refs (commits, tags, branches):

```json
{
  "tool": "compare_files",
  "git_repo": "/path/to/repo",
  "from_ref": "v1.0.0",
  "to_ref": "v2.0.0",
  "instructions": "Focus on API breaking changes and security implications"
}
```

`to_ref` defaults to `HEAD` if omitted.

## Check for broken code references after refactoring

```json
{
  "tool": "check_references",
  "input_files_paths": "/path/to/file.ts",
  "instructions": "This is a TypeScript MCP server. Check all symbol references are valid."
}
```

## Check for broken file imports

```json
{
  "tool": "check_imports",
  "input_files_paths": "/path/to/file.ts"
}
```

## Reuse instructions across operations

```json
{
  "tool": "code_task",
  "answer_mode": 0,
  "max_retries": 3,
  "instructions_files_paths": "/path/to/review-rules.md",
  "input_files_paths": ["/path/a.ts", "/path/b.ts"]
}
```

## Simple task with ensemble off (save tokens)

```json
{
  "tool": "chat",
  "instructions": "What is the main export of this module?",
  "input_files_paths": "/path/to/file.ts",
  "ensemble": false
}
```

## Quick factual answer with low max_tokens

```json
{
  "tool": "chat",
  "instructions": "List the function names exported from this module. One per line.",
  "input_files_paths": "/path/to/file.ts",
  "max_tokens": 500,
  "temperature": 0.1,
  "ensemble": false
}
```

## Code review with persona

```json
{
  "tool": "chat",
  "instructions": "Review this Python CLI script for error handling gaps.",
  "input_files_paths": "/path/to/cli.py",
  "system": "Senior Python CLI developer"
}
```

## Scan folder with gitignore + excluded dirs

```json
{
  "tool": "scan_folder",
  "folder_path": "/path/to/project",
  "extensions": [".py"],
  "use_gitignore": true,
  "exclude_dirs": ["migrations", "fixtures"],
  "instructions": "Find security vulnerabilities. This is a Django REST API."
}
```

## Use folder_path on any tool

All content tools (except `scan_folder` which requires it, and `compare_files` which has its own modes) accept `folder_path` to auto-discover files from a directory. Can be combined with `input_files_paths`:

```json
{
  "tool": "code_task",
  "folder_path": "/path/to/src",
  "extensions": [".ts"],
  "recursive": true,
  "follow_symlinks": true,
  "use_gitignore": true,
  "max_files": 2500,
  "instructions": "Find potential null pointer exceptions. TypeScript Node.js project."
}
```

Combining `folder_path` with explicit files:

```json
{
  "tool": "chat",
  "folder_path": "/path/to/src/utils",
  "extensions": [".ts"],
  "input_files_paths": ["/path/to/src/index.ts"],
  "instructions": "Summarize what this module does. All utils + the entry point."
}
```

## Redact custom patterns

Use `redact_regex` to redact matching strings before they reach the LLM:

```json
{
  "tool": "chat",
  "instructions": "Review this configuration for best practices",
  "input_files_paths": "/path/to/config.ts",
  "redact_regex": "https?://[a-zA-Z0-9._:/-]+"
}
```

Alphanumeric matches become `[REDACTED:USER_PATTERN]`, numeric-only matches become zero-padded placeholders. Works on all content tools alongside `scan_secrets` and `redact_secrets`.

## Check source against specification

```json
{
  "tool": "check_against_specs",
  "spec_file_path": "/path/to/api-spec.md",
  "input_files_paths": "/path/to/impl.ts",
  "instructions": "Check compliance with the API contract"
}
```

## Check entire folder against specification

```json
{
  "tool": "check_against_specs",
  "spec_file_path": "/path/to/rules.md",
  "folder_path": "/path/to/src",
  "extensions": [".ts"],
  "use_gitignore": true,
  "instructions": "Check if forbidden endpoints are used"
}
```

## Grouped file processing (isolated reports)

```json
{
  "tool": "code_task",
  "instructions": "Find bugs and security issues. This is a Node.js API.",
  "input_files_paths": [
    "---GROUP:auth---",
    "/path/to/auth.ts",
    "/path/to/auth.test.ts",
    "---/GROUP:auth---",
    "---GROUP:api---",
    "/path/to/routes.ts",
    "/path/to/middleware.ts",
    "---/GROUP:api---"
  ]
}
```

Returns one report per group:
```
[group:auth] /path/to/reports_dev/llm_externalizer/code_task_group-auth_...md
[group:api] /path/to/reports_dev/llm_externalizer/code_task_group-api_...md
```

## Code-optimized analysis

```json
{
  "tool": "code_task",
  "instructions": "Audit for security vulnerabilities",
  "input_files_paths": "/path/to/file.ts",
  "ensemble": true
}
```
