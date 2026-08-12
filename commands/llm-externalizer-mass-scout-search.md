---
name: llm-externalizer-mass-scout-search
description: |-
  Per-job search across mass-scouting results. Three modes auto-routed:
  regex (for trivial queries — emails, urls, ipv4, etc.), FTS5 keyword
  search, and structured JSON1 path filters. Phase 5 of the pipeline.
allowed-tools:
  - Bash
argument-hint: "--db-path <path> --job-id <id> [--query \"...\"] [--regex \"...\"] [--filter '$.x:=:val'] [--json]"
effort: low
---

# Mass-scout — search

Query a single job's results. The dispatcher auto-routes to:

1. **regex** — `--regex "..."` OR a query that matches a built-in pattern
   ("find all emails", "urls of domain X", "all ipv4", "all phone numbers",
   "all hex colors", "all semver", "all github repos", "all aws keys").
   Runs programmatic regex over the cached file bodies. Never hits the LLM.
2. **fts** — natural-language keyword query against the per-job FTS5 index.
3. **structured** — JSON1 path filters against `result_json`. Use for
   typed predicates like `$.is_async:=:true` or `$.complexity:>=:5`.
4. **combined** — when both `--query` and `--filter` are supplied, FTS
   narrows the candidate set first, then structured filters prune further.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | The registry |
| `--job-id <id>` | yes | The job to search |
| `--query "..."` | maybe | FTS5 query OR a natural-language query |
| `--regex "..."` | maybe | Explicit regex pattern (forces regex mode) |
| `--force-llm` | no | Suppress the regex bypass even on trivial queries |
| `--force-regex` | no | Force regex mode (requires `--regex` or a named-pattern query) |
| `--filter '...'` | no | Structured filter `path:OP:value`. Multiple filters: comma-comma separator (e.g. `'$.x:=:1,,$.y:>:5'`). |
| `--limit <n>` | no | Max hits returned. Default: 50 |
| `--offset <n>` | no | Skip the first N hits |
| `--json` | no | Return results as JSON instead of a human-readable table |

## Filter syntax

`path:OP:value` where:
- `path` — JSON1 path (e.g. `$.is_async`, `$.complexity`)
- `OP` — one of `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`
- `value` — `true` / `false` / `null` (literal), `42` / `3.14` (number),
  anything else (string)

## Built-in regex patterns

| Phrase | Pattern |
|---|---|
| `find all emails` / `all emails` | RFC-style email |
| `all urls` / `all links` | `https?://...` |
| `urls of domain X` / `links to X` | `https?://[^...]*X[^...]*` |
| `all ipv4` / `all ip addresses` | `\b(?:\d{1,3}\.){3}\d{1,3}\b` |
| `all phone numbers` | `\+?\d[\d\s().-]{6,}\d` |
| `all hex colors` | `#[0-9A-Fa-f]{3,8}\b` |
| `all semver` | `\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b` |
| `all github repos` | `\bgithub\.com/[\w.-]+/[\w.-]+\b` |
| `all aws keys` (security) | `\bAKIA[0-9A-Z]{16}\b` |

The response includes `regex_pattern` + `regex_reason` so you can audit
which pattern fired and why.

## Output

Default: human-readable table — one line per hit with `<short_id>
<file_path> :: <snippet>`. With `--json`, returns the full
`SearchResponse` envelope including per-hit `regex_matches` (line +
context window) for regex hits.

## Usage example

```
# Regex bypass — pull every email from a scouted job (never hits the LLM)
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-search --db-path ./scout.sqlite --job-id audit-1 --regex "all emails"

# FTS5 keyword search narrowed by a structured predicate, as JSON
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-search --db-path ./scout.sqlite --job-id audit-1 --query "retry backoff" --filter '$.is_async:=:true' --json
```
