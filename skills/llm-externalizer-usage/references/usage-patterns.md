# LLM Externalizer — Usage Patterns

## Table of Contents

- [Scan a codebase for issues](#scan-a-codebase-for-issues)
- [Analyze multiple files together](#analyze-multiple-files-together)
- [Apply same check to each file independently](#apply-same-check-to-each-file-independently)
- [Compare two file versions](#compare-two-file-versions)
- [Check for broken code references](#check-for-broken-code-references-after-refactoring)
- [Check for broken file imports](#check-for-broken-file-imports)
- [Reuse instructions across operations](#reuse-instructions-across-operations)
- [Simple task with ensemble off](#simple-task-with-ensemble-off-save-tokens)
- [Quick factual answer](#quick-factual-answer-with-low-max_tokens)
- [Code review with persona](#code-review-with-persona)
- [Scan folder with gitignore](#scan-folder-with-gitignore--excluded-dirs)
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

## Analyze multiple files together

```json
{
  "tool": "chat",
  "instructions": "Compare these configs and list differences",
  "input_files_paths": ["/path/a.yaml", "/path/b.yaml"]
}
```

## Apply same check to each file independently

```json
{
  "tool": "batch_check",
  "instructions": "Find all TODO comments and classify by urgency",
  "input_files_paths": ["/path/a.ts", "/path/b.ts", "/path/c.ts"]
}
```

## Compare two file versions

```json
{
  "tool": "compare_files",
  "input_files_paths": ["/path/old.ts", "/path/new.ts"],
  "instructions": "Focus on API breaking changes"
}
```

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
  "tool": "batch_check",
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
  "system": "Senior Python CLI developer",
  "temperature": 0.2
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
[group:auth] /path/to/llm_externalizer_output/code_task_group-auth_...md
[group:api] /path/to/llm_externalizer_output/code_task_group-api_...md
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
