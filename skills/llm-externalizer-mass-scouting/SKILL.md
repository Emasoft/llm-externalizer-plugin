---
name: llm-externalizer-mass-scouting
description: |-
  Search, classify, categorize, and triage many files via a cheap LLM into a
  queryable SQLite registry. Use when you have N files and need to know which
  are about X at any scale (hundreds to millions). Trigger with "mass scout",
  "triage this corpus", "categorize a folder", "build an inventory", "audit
  thousands of files", "PR review all changed files".
argument-hint: "[register | preclassify | estimate | scout | search | search-xjob | get | export | jobs-list | audit-sample | body-get | build-fieldset | propose-fieldset | list-bundled-fieldsets | diff | chain]"
effort: medium
---

# LLM Externalizer — Mass Scouting

## Overview

**This is the search-and-categorize tool for large file sets.** When you
need to triage a corpus, classify a folder, build an inventory, or find
which files match a topic — reach for mass-scouting instead of hand-rolling
`grep` / `find` / regex filter scripts. A regex matches literal strings; the
scout makes a real per-file classification judgement (e.g. "is this file
actually about X?") that brittle keyword filters get wrong.

Bulk LLM-driven structured-output file analysis. Point a cheap model
(default `qwen/qwen-2.5-7b-instruct`) at hundreds-to-millions of files; get
back a queryable SQLite registry of extractions defined by a per-call
**dynamic JSON Schema**. Every response is forced through that schema via
OpenRouter's `response_format: json_schema`.

Use when the user wants the SAME shape of metadata from every file. For
free-form prose, use the `chat` tool instead.

## Prerequisites

- `OPENROUTER_API_KEY` in env or via `userConfig.openrouter_api_key`.
- A target folder (or `file_paths[]`) and a fieldset (author one with
  `mass_scout_build_fieldset` / `mass_scout_propose_fieldset`, or pass
  `bundled:<name>` — sets: `code-audit`, `skill-audit`, `security-audit`,
  `pr-review`).
- `reports/` and `reports_dev/` in `.gitignore`.

## Instructions

Five phases, one MCP tool per phase, source in
`mcp-server/src/mass_scouting/cli.ts`.

1. **register** — walks a folder (honors `.gitignore`; `no_gitignore: true`
   to override) or takes `file_paths[]`; hashes + caches every body.
2. **preclassify** — script-tags every row with a bucket (binary /
   sourcecode / config / documentation / log / rules / unknown).
3. **estimate** — previews tokens, cost, eligible files. `budget_usd` is
   a hard gate. `live_context: true` queries OpenRouter for the real cap.
4. **scout** — compiles fieldset → JSON Schema, fans LLM calls out,
   repairs + validates, persists. Emits `notifications/progress` per file.
5. **search** — `mass_scout_search` (per-job) / `mass_scout_search_xjob`
   (cross-job): regex bypass / FTS5 / structured JSON1 / combined.

Follow-on tools: `jobs_list`, `audit_sample`, `body_get`,
`build_fieldset`, `propose_fieldset`, `diff` (compare two jobs),
`chain` (re-scout a filter-matched subset with a fresh fieldset).

## Output

`mass_scout` writes ONE markdown report under
`<main-repo-root>/reports/mass_scouting/<TIMESTAMP>-scout-<slug>.md` and
returns the file path plus counts. Hand the path to the user — never
re-print the report. Search/get/export emit JSON or JSONL/CSV.

The main-repo root is resolved from `CLAUDE_PROJECT_DIR`, then the
enclosing git worktree. When you call the MCP tool, pass an explicit
`output_dir` (`mass_scout` and `mass_scout_export` both accept it) so the
report lands in the project the user is working on — otherwise a packaged
MCP server can fall back to a path outside the project.

## Token efficiency

- Pass paths, never bodies. The registry reads bodies once at register
  time and serves them from cache.
- Prefer `bundled:<name>` over authoring JSON when a shipped set fits.
- Restrict by `bucket` (sourcecode / documentation / …) so scout skips
  binaries automatically.
- Use `mass_scout_search` (regex / FTS5 / structured) instead of
  `audit_sample` when you can — search returns matching rows only.
- Pass `json: true` + `limit_per_job` / `limit_merged` on large queries.

## Error Handling

- `HTTP 400 context length exceeded` → file > cap. Lower
  `max_context_pct_scout` or set `live_context: true`.
- `scout failed after N attempts` → see `mass_scout_skipped` table.
- `circuit_tripped=true` → ≥5 consecutive failures; investigate first.
- Missing `OPENROUTER_API_KEY` → set env / userConfig.

Flowchart: [troubleshooting](references/troubleshooting.md).

## Examples

Trigger phrases: "audit every .ts file under src/ for complexity",
"scan all skills for weak triggers", "PR review every changed file",
"find every Python module that talks to a database".

Concrete input → output:

```
mass_scout_estimate { db_path:/tmp/x.db, fields_file:bundled:code-audit,
                      budget_usd:0.50 }
  → files_eligible=50  est_cost_usd=$0.0015  budget_allowed=true

mass_scout { db_path:/tmp/x.db, fields_file:bundled:code-audit,
             job_id:audit-1, source_root:/path/src }
  → files_ok=50  files_failed=0  cost_usd=$0.0014
    report=<main-root>/reports/mass_scouting/<TS>-scout-audit-1.md
```

End-to-end: [worked-example](references/worked-example.md).

## Resources

- [troubleshooting](references/troubleshooting.md) — Symptom flowchart, Failure modes, Resume.
- [worked-example](references/worked-example.md) — Pipeline run, Cost rules-of-thumb, Reading the report.
- [fieldsets](references/fieldsets.md) — Fieldset format, Bundled fieldsets, Build-fieldset shorthand, Propose-fieldset.
- [glossary](references/glossary.md) — Terms, Model selection guide, Privacy.
- Source: `mcp-server/src/mass_scouting/`, `mcp-server/fieldsets/`.
