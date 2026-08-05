# Use LLM Externalizer (CLI)

> **PRECONDITION — applies ONLY if the `llm-externalizer` plugin is installed AND enabled.**
> Auto-installed to `~/.claude/rules/`, so it loads in **every** session. Check with
> `test -x "$CLAUDE_PLUGIN_ROOT/bin/llm-ext"`, or just run `llm-ext --help`. If that binary
> is not there, **IGNORE THIS ENTIRE FILE** — do not mention or attempt to use anything below.
>
> **There is no MCP server any more.** If you are looking for `mcp__…llm-externalizer…__*`
> tools, they do not exist — every capability is `llm-ext <command>`, run through Bash.

**Prefer LLM Externalizer over Haiku subagents for bounded tasks** — more capable, cheaper,
and it keeps verbose output out of your context (every command prints just a report-file
path; Read it when needed). It analyzes code, it does not edit it.

**How to call it.** `"$CLAUDE_PLUGIN_ROOT/bin/llm-ext" <command> [--flag value ...]`.
`llm-ext --help` lists all 42 commands; `llm-ext <command> --help` prints that command's
real parameters. Parameter names are the ones this tool always used, now as `--flags`.
The report path goes to STDOUT (so it pipes cleanly); banner, progress and errors go to
STDERR; exit 1 means it failed.

```bash
llm-ext discover                                    # health, active profile, free mode
llm-ext scan-folder --folder_path src/ --instructions "find bugs"
llm-ext search-existing-implementations --folder_path . --feature_description "retry with backoff"
llm-ext chat --instructions "Summarize" --input_files_paths /path/to/file.ts
```

**Long commands need an explicit timeout.** `mass-scout*`, `security-scan`,
`high-quality-scan` and the benchmarks run for tens of minutes. Give the Bash call a
20-minute timeout or run it in the background — there is no protocol keepalive to lean on.

**Reach for it when:** reading/summarizing/analyzing files (large, or 3+), scanning a
codebase for bugs/security/dead code, processing tool output (lint/test logs, big JSON),
generating boilerplate/stubs, comparing files, checking broken imports/refs after a
refactor, or getting a second opinion.

**Don't use it for:** surgical edits (Read+Edit), multi-step logic needing tool access
(git/fs/web), reasoning only Opus can handle, or applying fixes (write tools are inactive).

**Cost safety — ESTIMATE BEFORE EVERY PAID RUN:** when the active profile is PAID (free mode
off), run the same command with `--estimate` FIRST — it dry-runs the invocation (same file
resolution, same ensemble slots, zero LLM sends, ~3s) and prints two numbers per model:
`expected` (calibrated average) and `ceiling` (every request bills its full max_tokens — the
amount that cannot be exceeded). Proceed only when the ceiling fits the budget; on a free
profile `--estimate` is optional (everything is $0).

```bash
llm-ext scan-folder --estimate --folder_path src/ --instructions "find bugs"   # predicted cost, nothing sent
llm-ext scan-folder --folder_path src/ --instructions "find bugs"              # the real run, once the ceiling fits
```

**Cost safety — free mode (zero spend, ALL tools):** to guarantee not a single cent is spent
on OpenRouter, set `free_only: true` on the active profile in
`~/.llm-externalizer/settings.yaml` with a `free_models:` pool of `:free` model ids (then
`reset`). Under `free_only` the free pool **OVERRIDES every per-tool choice** — every tool
(`chat`, `code_task`, `scan_folder`, `security_scan`, `cluster_synonyms`, `mass_scout`,
`check_*`, `compare_files`, …), every ensemble slot, every rate-limit fallback, and even a
`tool_models:` override or a credit-exhaustion fallback uses ONLY `:free` models. The server
**refuses (throws, before the request) to send any non-`:free` model** while free mode is on,
so a misconfiguration fails fast instead of billing. If a task must be zero-cost and the
active profile is a paid one, **switch to a `free_only` profile FIRST** — verify with
`discover` / `get_settings` (active profile + free mode shown). Free models are heavily
rate-limited (daily caps) but cost $0; the ensemble rotates across the pool on a daily-limit
hit. Full recipe: README "B2. OpenRouter free-only ensemble".

**Auto-free on low balance — DON'T refuse on budget/credit errors:** even on a *paid* profile,
when the OpenRouter balance drops below **$1.00** (configurable via `LLM_EXT_FREE_BELOW_USD`) —
or any call returns a 402 "insufficient credits" — the server **auto-engages free mode for the
rest of the session** and routes every tool (the main ensemble *and* `security_scan` /
`mass_scout`) through the rotating free pool at **$0**. So a near-empty wallet is **never** a
reason to refuse this tool or to fall back to doing the work yourself — the call still succeeds,
just on free models. The single-model fallback (`free: true` flag, 402 single-retry) uses
`LLM_EXT_FREE_MODEL_ID` (a validated `:free` model; a non-`:free` value is rejected). If a tool
returns a report path, it worked — read the report instead of assuming the tool is unavailable.

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
- Per-command params/behavior → `llm-ext <command> --help`. That help is generated from the
  same catalog the commands run from, so it cannot drift. `llm-ext --help` lists all 42
  (`chat`, `code-task`, `scan-folder`, `review-plan`, `rules-check`, `compare-files`,
  `check-references`, `check-imports`,
  `check-against-specs`, `search-existing-implementations`, `security-scan`,
  `cluster-synonyms`, `discover`, `get-settings`, `or-model-info*`, `reset`, the
  `mass-scout-*` family, and the model-health/benchmark commands).
- Profiles, auth, ensemble, and per-tool model routing (`tool_models`) → `llm-ext discover`
  for live status; config is **user-only** (edit `~/.llm-externalizer/settings.yaml` by hand)
  — there is no set-settings/change-model command.
- `llm-ext reset` purges the on-disk caches. It does NOT restart anything: every invocation
  is already a fresh process.
- Scan / fix / config recipes → the plugin's skills and slash commands.

Auth auto-detects from `$OPENROUTER_API_KEY` (or the plugin keychain
`userConfig.openrouter_api_key`, exported to child processes as
`$CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY`). Don't report an auth error if
`llm-ext discover` shows the token resolved.
