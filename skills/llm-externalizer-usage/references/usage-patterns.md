# LLM Externalizer — Usage Patterns

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

## Code-optimized analysis

```json
{
  "tool": "code_task",
  "instructions": "Audit for security vulnerabilities",
  "input_files_paths": "/path/to/file.ts",
  "ensemble": true
}
```
