---
name: free-scan
description: Scan the current project with the free Nemotron model (no cost, lower quality)
allowed-tools:
  - mcp__llm-externalizer__discover
  - mcp__llm-externalizer__scan_folder
argument-hint: "[folder_path] [instructions]"
effort: high
---

Run a full project scan using the **free** Nemotron 3 Super model (no cost, no ensemble).

**Important**: This uses a significantly weaker model than the ensemble. Expect more false positives, missed bugs, and shallow analysis. Do not use with sensitive or proprietary code — prompts are logged by the provider.

## Steps

1. Call `discover` to verify the service is online
2. Determine the scan target:
   - If the user provided a folder path argument, use it
   - Otherwise, use the current working directory
3. Call `scan_folder` with these parameters:
   - `folder_path`: the target directory (absolute path)
   - `free`: true
   - `use_gitignore`: true
   - `instructions`: if the user provided instructions in the argument, use them. Otherwise use: "Audit for bugs, error handling gaps, security issues, and resource leaks. Reference function names."
4. The tool returns one report path per file. List them for the user.
5. Summarize: total files scanned, any failures, and remind the user this is a low-quality free scan.
