---
name: free-scan
description: Scan the current project with the free Nemotron model (no cost, lower quality)
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
argument-hint: "<prompt>"
effort: high
---

Run a full project scan using the **free** Nemotron 3 Super model (no cost, no ensemble).

**Important**: This uses a significantly weaker model than the ensemble. Expect more false positives, missed bugs, and shallow analysis. Do not use with sensitive or proprietary code — prompts are logged by the provider.

## Argument parsing

The `<prompt>` is free-form text. Parse it for any of these:

- **Folder path** — if the prompt contains an absolute path (starts with `/`), use it as `folder_path`. Otherwise use the current working directory.
- **File extensions** — if the prompt mentions extensions like `.ts`, `.py`, `.md`, or says "only typescript files", extract them as `extensions` (e.g. `[".ts"]`).
- **Exclude dirs** — if the prompt mentions directories to skip (e.g. "skip tests", "ignore migrations"), extract them as `exclude_dirs`.
- **Instructions** — everything else is passed as `instructions` to the LLM. This is what the model will look for in each file.

Examples:
- `/free-scan` — scan cwd, default instructions
- `/free-scan find security issues` — scan cwd, custom instructions
- `/free-scan /path/to/src .ts .py find dead code` — scan /path/to/src, only .ts and .py files, look for dead code
- `/free-scan skip tests find TODO comments` — scan cwd, exclude tests dir, find TODOs

## Steps

1. Call `discover` to verify the service is online
2. Parse the prompt (see above)
3. Call `scan_folder` with:
   - `folder_path`: parsed path or cwd
   - `free`: true
   - `use_gitignore`: true
   - `extensions`: if parsed from prompt
   - `exclude_dirs`: if parsed from prompt
   - `instructions`: parsed instructions, or default: "Audit for bugs, error handling gaps, security issues, and resource leaks. Reference function names."
4. The tool returns one report path per file. List them for the user.
5. Summarize: total files scanned, any failures, and remind the user this is a low-quality free scan.
