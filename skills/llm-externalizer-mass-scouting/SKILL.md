---
name: llm-externalizer-mass-scouting
description: |-
  Use when extracting the SAME structured metadata from many files with a
  cheap LLM. Trigger with "mass scout", "scan many files for X", "extract
  structured data from a folder", "classify all my files", "audit thousands
  of files", "run a fieldset over a codebase", "audit my plugin", "PR review
  all changed files", "security-scan this repo".
argument-hint: "[register | preclassify | estimate | scout | search | search-xjob | get | export | jobs-list | audit-sample | body-get | build-fieldset | propose-fieldset | list-bundled-fieldsets | diff | chain]"
effort: medium
---

# LLM Externalizer — Mass Scouting

## Overview

Bulk LLM-driven structured-output file analysis. Point a cheap model
(default `qwen/qwen-2.5-7b-instruct`) at hundreds-to-millions of files; get
back a queryable SQLite registry of extractions defined by a per-call
**dynamic JSON Schema**. Every response is forced through that schema via
OpenRouter's `response_format: json_schema`.

Use when the user wants the SAME shape of metadata from every file. For
free-form prose, use the `chat` tool instead.

## Prerequisites

- `OPENROUTER_API_KEY` in env or via `userConfig.openrouter_api_key`.
- A target folder (or `file_paths[]`) and a fieldset — author one with
  `mass_scout_build_fieldset` / `mass_scout_propose_fieldset`, or pass
  `bundled:<name>` (sets: `code-audit`, `skill-audit`, `security-audit`,
  `pr-review`). Run `mass_scout_list_bundled_fieldsets` for fields.
- `reports/` and `reports_dev/` in `.gitignore`.

## Instructions

Five phases, one MCP tool per phase, same code in
`mcp-server/src/mass_scouting/cli.ts`.

1. **register** — `mass_scout_register` walks a folder (honors `.gitignore`
   by default; `no_gitignore: true` to override) or takes `file_paths[]`,
   hashes each body, caches it in SQLite. Idempotent.
2. **preclassify** — `mass_scout_preclassify` script-tags every row with a
   bucket (binary / sourcecode / config / documentation / log / rules /
   unknown).
3. **estimate** — `mass_scout_estimate` previews tokens, dollars, eligible
   files. `budget_usd` is a hard gate. `live_context: true` queries
   OpenRouter for the provider's real cap (KNOWN_PRICING ceiling = model
   MAX, not provider cap — they differ).
4. **scout** — `mass_scout` compiles the fieldset to JSON Schema, fans
   calls out, repairs envelopes, validates, persists. Emits MCP
   `notifications/progress` per file.
5. **search** — `mass_scout_search` (per-job) / `mass_scout_search_xjob`
   (cross-job): regex bypass / FTS5 / structured JSON1 / combined.

Follow-on tools: `mass_scout_jobs_list`, `mass_scout_audit_sample`,
`mass_scout_body_get`, `mass_scout_build_fieldset`,
`mass_scout_propose_fieldset`, `mass_scout_diff` (row-by-row two-job
compare), `mass_scout_chain` (re-scout a filter-matched subset with a
fresh fieldset).

## Output

`mass_scout` writes ONE markdown report under
`<main-repo-root>/reports/mass_scouting/<TIMESTAMP>-scout-<slug>.md` and
returns the file path plus counts. Hand the path to the user — never
re-print the report. Search/get/export emit JSON or JSONL/CSV.

## Error Handling

- `HTTP 400 context length exceeded` → file > provider cap. Lower
  `max_context_pct_scout` or set `live_context: true`.
- `scout failed after N attempts` → recorded in `mass_scout_skipped` table.
- `circuit_tripped=true` → too many consecutive failures (default 5).
  Investigate before retrying.
- Missing `OPENROUTER_API_KEY` → set the env var or
  `userConfig.openrouter_api_key`.

Full flowchart: [troubleshooting](references/troubleshooting.md).

## Examples

```
"audit every TypeScript file under mcp-server/src for complexity issues"
"scan all skills for missing triggers and weak descriptions"
"PR review every file changed since main"
"find every Python module that talks to a database"
```

Worked end-to-end run: [worked-example](references/worked-example.md).

## Resources

- `mcp-server/src/mass_scouting/` — source.
- `mcp-server/fieldsets/` — bundled fieldset JSONs.
- [troubleshooting](references/troubleshooting.md) — failure-mode flowchart.
- [worked-example](references/worked-example.md) — plugin-audit walkthrough.
- [fieldsets](references/fieldsets.md) — types, bundled sets, shorthand, propose.
- [glossary](references/glossary.md) — terms, model selection, privacy.
- TRDD `design/tasks/TRDD-52547970-77f3-441c-9e8e-60be22cd2770-mass-scouting.md`.
