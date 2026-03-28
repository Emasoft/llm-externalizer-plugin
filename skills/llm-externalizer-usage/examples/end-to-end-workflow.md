# End-to-End Workflow: Using LLM Externalizer

## Table of Contents

- [Scenario: Security audit](#scenario-security-audit-of-a-typescript-project)
- [Quick Decision Tree](#quick-decision-tree)

Complete example showing tool selection, invocation, output reading, and acting on results.

## Scenario: Security audit of a TypeScript project

### Step 1: Choose the right tool

- Need to scan multiple files in a directory? Use `scan_folder`.
- Need to analyze specific files? Use `code_task` or `batch_check`.
- Need to compare two files? Use `compare_files`.

For a directory scan: `scan_folder`.

### Step 2: Call the tool

```json
{
  "tool": "mcp__llm-externalizer__scan_folder",
  "folder_path": "/path/to/project/src",
  "extensions": [".ts"],
  "instructions": "Find security vulnerabilities. This is a Node.js Express REST API with JWT auth. Focus on: SQL injection, XSS, SSRF, path traversal, and auth bypass.",
  "use_gitignore": true,
  "exclude_dirs": ["__tests__", "fixtures"]
}
```

### Step 3: Read the tool response

The tool returns ONLY a file path:
```
/path/to/project/llm_externalizer_output/scan_folder_20260315_143022.md
```

Read the output file:
```
Read /path/to/project/llm_externalizer_output/scan_folder_20260315_143022.md
```

### Step 4: Act on the findings

The output file contains the LLM's analysis with per-file findings. Use the findings to:
- Create GitHub issues for each vulnerability
- Fix critical issues using Read + Edit tools
- Run `check_references` on modified files to verify fixes didn't break imports

### Step 5: Follow up (optional)

Re-scan specific fixed files to verify:
```json
{
  "tool": "mcp__llm-externalizer__batch_check",
  "instructions": "Verify these files have no remaining security vulnerabilities. This is a Node.js Express REST API.",
  "input_files_paths": ["/path/to/fixed-file-1.ts", "/path/to/fixed-file-2.ts"]
}
```

## Quick Decision Tree

```
Need to process files with an external LLM?
|
+-- How many files?
    |
    +-- 1 file, code analysis --> code_task
    +-- 1 file, general task --> chat
    +-- 2 files, compare --> compare_files
    +-- 2+ files, same check each --> batch_check
    +-- Whole directory --> scan_folder
    +-- Check imports valid --> check_imports
    +-- Check symbol refs --> check_references
    +-- Check against spec --> check_against_specs
```
