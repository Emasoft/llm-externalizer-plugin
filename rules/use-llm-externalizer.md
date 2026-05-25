# Use LLM Externalizer MCP

> **PRECONDITION — applies ONLY if the `llm-externalizer` plugin is installed AND enabled.**
> Auto-installed to `~/.claude/rules/` by the plugin's MCP server, so it loads in **every**
> session. If the `mcp__plugin_llm-externalizer_llm-externalizer__*` tools are NOT available,
> **IGNORE THIS ENTIRE FILE** — do not mention or attempt to use anything below.

**Prefer LLM Externalizer over Haiku subagents for bounded tasks** — more capable, cheaper,
and it keeps verbose output out of your context (every tool returns just a report-file path;
Read it when needed). It analyzes code, it does not edit it.

**Reach for it when:** reading/summarizing/analyzing files (large, or 3+), scanning a
codebase for bugs/security/dead code, processing tool output (lint/test logs, big JSON),
generating boilerplate/stubs, comparing files, checking broken imports/refs after a
refactor, or getting a second opinion.

**Don't use it for:** surgical edits (Read+Edit), multi-step logic needing tool access
(git/fs/web), reasoning only Opus can handle, or applying fixes (write tools are inactive).

**Gotchas worth remembering:**
1. Pass file **paths** (`input_files_paths`), never file contents — the server reads from
   disk; pasting content wastes your tokens.
2. The LLM never sees all your files at once — multi-file tools batch ~1–5 files per request.
   For whole-codebase cross-file questions ("is this implemented anywhere?", "find duplicate
   declarations") use `search_existing_implementations`, not a different `answer_mode`
   (`answer_mode` only changes how reports are split on disk).
3. Reports always land in `<main-project-dir>/reports/llm-externalizer/` (anchored on
   `$CLAUDE_PROJECT_DIR` verbatim, never git). Pass an absolute `output_dir` to override.
4. The remote LLM knows nothing about your project — include brief context in `instructions`.

**Details live on demand — don't duplicate them here:**
- Per-tool params/behavior → each tool's own MCP description: `chat`, `code_task`,
  `scan_folder`, `compare_files`, `check_references`, `check_imports`, `check_against_specs`,
  `search_existing_implementations`, `security_scan`, `cluster_synonyms`, `assess_model`,
  `check_model_health`, `security_triage_benchmark`, `discover`, `get_settings` (read-only),
  `or_model_info*`, `reset`.
- Profiles, auth, ensemble, and per-tool model routing (`tool_models`) → `discover` for live
  status; config is **user-only** (edit `~/.llm-externalizer/settings.yaml` by hand, then
  `reset`) — there is no `set_settings`/`change_model` tool.
- Scan / fix / config recipes → the plugin's skills and slash commands.

Auth auto-detects from `$OPENROUTER_API_KEY` (or the plugin keychain
`userConfig.openrouter_api_key`). Don't report an auth error if `discover` shows the token
resolved.
