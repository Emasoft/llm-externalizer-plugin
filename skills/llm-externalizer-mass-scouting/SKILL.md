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

Search-and-categorize for large file sets. Triage a corpus, classify a folder, build an inventory, or find which files match a topic. Reach for mass-scouting instead of hand-rolling `grep`/`find`/regex filters — the scout makes a per-file classification judgement that brittle keyword filters miss.

Bulk LLM-driven structured-output analysis. Point a cheap model (default `qwen/qwen-2.5-7b-instruct`) at hundreds-to-millions of files; get back a queryable SQLite registry of extractions defined by a per-call **dynamic JSON Schema**. Use when the user wants the SAME shape of metadata from every file. For free-form prose, use `llm ask`.

## Prerequisites

- `OPENROUTER_API_KEY` in env or via `userConfig.openrouter_api_key`.
- A target folder (or `--file_paths`) and a fieldset (author one with
  `scout build-fieldset` / `scout propose-fieldset`, or pass
  `bundled:<name>` — sets: `code-audit`, `skill-audit`, `security-audit`,
  `pr-review`).
- `reports_dev/` in `.gitignore` (intermediate and scratch output); `reports/` stays git tracked and holds final reports only, sanitized of secrets before committing. Subagents you spawn save temporary or scratch files to the `*_dev` folders and final files to the tracked ones.

## Instructions

Five phases, one CLI command per phase (`llm-ext scout <phase>`),
source in `scripts/llm-ext/src/mass_scouting/cli.ts`.

1. **register** (`scout register`) — walks a folder (honors
   `.gitignore`; `--no_gitignore` to override) or takes `--file_paths`;
   hashes + caches every body.
2. **preclassify** (`scout preclassify`) — script-tags every row with a
   bucket (binary / sourcecode / config / documentation / log_to_classify /
   rules_to_eval / has_frontmatter / unknown).
3. **estimate** (`scout estimate`) — previews tokens, cost, eligible
   files. `--budget_usd` is a hard gate. `--live_context` queries
   OpenRouter for the real cap.
4. **scout** (`scout run`) — compiles fieldset → JSON Schema, fans LLM
   calls out, repairs + validates, persists.
5. **search** (`scout search`, per-job) / (`scout search-xjob`,
   cross-job): regex bypass / FTS5 / structured JSON1 / combined.

Follow-on commands: `scout jobs`, `scout audit-sample`,
`scout body-get`, `scout build-fieldset`,
`scout propose-fieldset`, `scout diff` (compare two jobs),
`scout chain` (re-scout a filter-matched subset with a fresh fieldset).

## Output

`scout run` writes ONE report under `<main-project-dir>/reports/llm-externalizer/mass_scouting/<TIMESTAMP>-scout-<slug>.md` and returns the path plus counts. The main project dir is `$CLAUDE_PROJECT_DIR` (used verbatim) with a cwd fallback — never derived from git. Hand path to user; never re-print. Search/get/export emit JSON/JSONL/CSV. Pass `--output_dir` explicitly to land elsewhere.
Intermediate output (the per-file pieces of a merged run, a partial run, model-pool benchmark and health reports) defaults to `<root>/reports_dev/llm-externalizer/<sub>/`; final reports stay in `reports/llm-externalizer/` (TRDD-PNU8XECB). Mass-scouting temp output follows the same split.

Token efficiency: pass paths not bodies; prefer `bundled:<name>` fieldsets; restrict by `--bucket`; use `scout search` over `scout audit-sample`; pass `--json` + `--limit*` on large queries.

## Error Handling

- `HTTP 400 context length exceeded` → file > cap. Lower
  `--max_context_pct_scout` or set `--live_context`.
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
llm-ext scout estimate --db_path /tmp/x.db --fields_file bundled:code-audit \
  --budget_usd 0.50
  → files_eligible=50  est_cost_usd=$0.0015  budget_allowed=true

llm-ext scout run --db_path /tmp/x.db --fields_file bundled:code-audit \
  --job_id audit-1 --source_root /path/src
  → files_ok=50  files_failed=0  cost_usd=$0.0014
    report=<main-project-dir>/reports/llm-externalizer/mass_scouting/<TS>-scout-audit-1.md
```

End-to-end: [worked-example](references/worked-example.md).

## Resources

- [troubleshooting](references/troubleshooting.md) — Symptom flowchart, Failure modes, Resume.
- [worked-example](references/worked-example.md) — Pipeline run, Cost rules-of-thumb, Reading the report.
- [fieldsets](references/fieldsets.md) — Fieldset format, Bundled fieldsets, Build-fieldset shorthand, Propose-fieldset.
- [glossary](references/glossary.md) — Terms, Model selection guide, Privacy.
- Source: `scripts/llm-ext/src/mass_scouting/`, `scripts/llm-ext/fieldsets/`.
