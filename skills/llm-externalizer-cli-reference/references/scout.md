# llm-ext reference: scout group (mass scouting)

Flags are written `--name value`; booleans take `true`/`false`. Every action also accepts the global flags (`--quiet`, `--profile <name>`). All text below comes from `llm-ext <group> <action> --help`.

## Contents

- `llm-ext scout run`
- `llm-ext scout register`
- `llm-ext scout preclassify`
- `llm-ext scout estimate`
- `llm-ext scout search`
- `llm-ext scout search-xjob`
- `llm-ext scout get`
- `llm-ext scout export`
- `llm-ext scout jobs`
- `llm-ext scout audit-sample`
- `llm-ext scout body-get`
- `llm-ext scout build-fieldset`
- `llm-ext scout propose-fieldset`
- `llm-ext scout diff`
- `llm-ext scout chain`
- `llm-ext scout list-fieldsets`

## `scout` group


### `llm-ext scout run`

- Usage: `llm-ext scout run [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: scouting

mass-scouting Phase 4: actually call the LLM on every eligible file. Compiles the fieldset into a JSON Schema, fans calls out via the scout worker, applies fix_envelope repairs, runs the required-keys validator, persists results + FTS rows. Writes a markdown report under <main-project-dir>/reports/mass_scouting/ (override with output_dir).

RETURNS: files_total/ok/failed/skipped_too_big, retries, cost_usd, report path.

PROFILE: mass scouting takes its model from a `scouting`-type profile, whatever the active profile is (the free pool is never used). With the unpopulated `scouting` placeholder it refuses and the USER must run `llm-ext benchmark scout-accuracy`. `--profile` may name another scouting-type profile; a profile of another type is refused.

ENV: $OPENROUTER_API_KEY must be set.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--allow_untested_model` | boolean | Force ONE invocation with a model that has no scout-accuracy PASS. Runs a structural schema... |
| `--bucket` | string | Optional preclassifier bucket filter. |
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--fields_file` | string | (required) Absolute path to the JSON fieldset file (see TRDD §5). |
| `--job_id` | string | (required) Stable job identifier (e.g. 'scout-2026-05-06-audit'). Re-running scout with the same id... |
| `--live_context` | boolean | Query OpenRouter for the actual provider context_length and use it instead of... |
| `--max_context_pct_scout` | number | Override the default 40% scout cap. 0..1. |
| `--max_retries` | number | Per-file retry budget (excluding first attempt). Default: 1. |
| `--model` | string | Must be scout-accuracy-verified (ledger PASS under the current dataset hash) — see the... |
| `--no_resume` | boolean | Re-process files even if they already have a result row for this job_id. |
| `--no_smoke_test` | boolean | Skip the 5-file smoke test that runs sequentially before fan-out. |
| `--output_dir` | string | Absolute path for the markdown report directory. Defaults to... |
| `--source_root` | string | (required) Original folder the files came from. Recorded on the job row for the report. |
| `--workers` | number | Concurrent OpenRouter calls. Default: 16. |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scout run --db_path /tmp/scout.db --fields_file /tmp/has_async.json --job_id scout-audit --source_root ./src
```

### `llm-ext scout register`

- Usage: `llm-ext scout register [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: scouting

mass-scouting Phase 1: register every file under a folder (or a supplied file list) into the SQLite body cache. Files larger than the model's register cap (default 50% of context) are recorded as skipped. Idempotent — re-registering the same body returns the existing short_id.

RETURNS: one-line counter summary (registered/already_registered/skipped_too_big/skipped_read_error).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--exclude_dirs` | array | Additional directory names to skip during the walk. Built-in skips: .git, node_modules,... |
| `--extensions` | array | Filter the walk to these extensions (e.g. ['.ts', '.md']). Only used with folder_path. |
| `--file_paths` | array | Explicit list of absolute file paths. Mutually exclusive with folder_path. |
| `--folder_path` | string | Absolute path to the folder to walk. Mutually exclusive with file_paths. |
| `--git_diff` | string | Restrict registration to files changed since this git ref (uses `git diff --name-only... |
| `--max_context_pct_register` | number | Override the default 50% of context cap. 0..1 fraction. |
| `--model` | string | Model id (default: qwen/qwen-2.5-7b-instruct). Used to compute the register byte-cap. |
| `--no_gitignore` | boolean | Bypass .gitignore filtering. Default: gitignored files are skipped. |

Example:
```bash
llm-ext scout register --db_path /tmp/scout.db --folder_path ./src --extensions .ts
```

### `llm-ext scout preclassify`

- Usage: `llm-ext scout preclassify [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: scouting

mass-scouting Phase 2: cheap script-only classifier. Reads body bytes from the cache (no disk re-read), assigns each file a bucket — binary, rules_to_eval, has_frontmatter, documentation, sourcecode, config, log_to_classify, unknown — plus language and format tags.

RETURNS: total / classified / skipped / by-bucket counts.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--limit` | number | Only process this many rows. Useful for incremental runs. |
| `--reclassify` | boolean | Re-run the classifier on already-classified rows (default: false). |

Example:
```bash
llm-ext scout preclassify --db_path /tmp/scout.db
```

### `llm-ext scout estimate`

- Usage: `llm-ext scout estimate [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: scouting

mass-scouting Phase 3: cost / time estimate for a fieldset against the registered files. Honors the budget gate (--budget_usd). Pure — no LLM calls.

RETURNS: files_eligible, files_skipped_too_big, total_input_tokens, total_output_tokens, est_cost_usd, est_seconds, budget_allowed.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--bucket` | string | Optional preclassifier bucket filter (e.g. 'sourcecode'). |
| `--budget_usd` | number | If supplied, refuses to schedule when est_cost_usd exceeds this value. |
| `--context_window` | number | Tokens (overrides KNOWN_PRICING). |
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--expected_output_bytes` | number | Estimated output JSON size per file. Default: 200. |
| `--fields_file` | string | (required) Absolute path to the JSON fieldset file (see TRDD §5 for format). |
| `--input_price_per_m` | number | USD per 1M input tokens (overrides KNOWN_PRICING). Must come with output_price_per_m +... |
| `--live_context` | boolean | Query OpenRouter for the active provider's actual context_length and use it as the cap... |
| `--max_context_pct_register` | number | Override the default 50% register cap. 0..1 fraction. |
| `--max_context_pct_scout` | number | Override the default 40% scout cap. 0..1 fraction. |
| `--model` | string | Model id. Default: qwen/qwen-2.5-7b-instruct. |
| `--output_price_per_m` | number | USD per 1M output tokens (overrides KNOWN_PRICING). |
| `--per_call_seconds` | number | Avg seconds per LLM call for the ETA. Default: 1.0. |
| `--workers` | number | Worker count for the ETA calculation. Default: 16 — matches the scout phase's default so... |

Example:
```bash
llm-ext scout estimate --db_path /tmp/scout.db --fields_file /tmp/has_async.json
```

### `llm-ext scout search`

- Usage: `llm-ext scout search [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

mass-scouting Phase 5: per-job search. Three modes (auto-routed):
  - regex   — explicit --regex OR a query that matches a built-in     pattern ('all emails', 'urls of domain X', 'all ipv4', etc.)
  - fts     — FTS5 query against the per-job index
  - structured — JSON1 path filters against result_json
  - combined — fts + structured (intersected)

Filters use 'path:OP:value' format (OP = =, !=, >, >=, <, <=, LIKE).

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--filter` | string | Comma-comma-separated structured filters. Each one is 'path:OP:value'. Example:... |
| `--force_llm` | boolean | Suppress the regex bypass even on trivial queries. |
| `--force_regex` | boolean | Force regex mode. Requires either an explicit `regex` or a query that matches a named pattern. |
| `--job_id` | string | (required) Stable job identifier (e.g. 'scout-2026-05-06-audit'). Re-running scout with the same id... |
| `--json` | boolean | Return results as JSON instead of a human-readable table. |
| `--limit` | number | Max hits returned. Default: 50. |
| `--offset` | number | Skip the first N hits (FTS / structured only). |
| `--query` | string | FTS5 query OR a natural-language query that may match a built-in regex pattern. |
| `--regex` | string | Explicit regex pattern. Forces regex mode regardless of query. |

Example:
```bash
llm-ext scout search --db_path /tmp/scout.db --job_id scout-audit --query "is_async"
```

### `llm-ext scout search-xjob`

- Usage: `llm-ext scout search-xjob [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Cross-job federated search. Same flags as mass_scout_search but takes job_ids (a list) and returns merged results tagged with the originating job. Per-job hits are bm25-ranked and capped by limit_per_job; the merged list is capped by limit_merged.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--filter` | string | Comma-comma-separated structured filters using 'path:OP:value' (OP = =, !=, >, >=, <, <=,... |
| `--force_llm` | boolean | Force the LLM-search path even if regex/FTS would normally handle the query. Costs the model. |
| `--force_regex` | boolean | Force the regex bypass — skip FTS / structured. |
| `--job_ids` | array | (required) Two or more job_ids to federate across. |
| `--json` | boolean | Return JSON instead of human-readable text. |
| `--limit_merged` | number | Cap on the final merged hit list. Default 200. |
| `--limit_per_job` | number | Cap per source job before merging. Default 100. |
| `--query` | string | Free-text query — auto-routed to the regex bypass for patterns like 'all emails', 'urls of... |
| `--regex` | string | Explicit regex executed over cached file bodies. Use to force the regex bypass when... |

Example:
```bash
llm-ext scout search-xjob --db_path /tmp/scout.db --job_ids scout-audit --job_ids scout-audit-2 --query "is_async"
```

### `llm-ext scout get`

- Usage: `llm-ext scout get [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Retrieve one file row by short_id. Optionally include the result row for a specific job by passing job_id.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--job_id` | string | Optional. When supplied, the result row from mass_scout_results is included. |
| `--short_id` | number | (required) Positive integer short_id from registerFile. |

Example:
```bash
llm-ext scout get --db_path /tmp/scout.db --short_id 1 --job_id scout-audit
```

### `llm-ext scout export`

- Usage: `llm-ext scout export [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Dump every result row of a job to JSONL or CSV under <main-project-dir>/reports/mass_scouting/. Useful for follow-up analysis in pandas, jq, etc.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--format` | string | 'jsonl' (default) or 'csv'. |
| `--job_id` | string | (required) Stable job identifier (e.g. 'scout-2026-05-06-audit'). Re-running scout with the same id... |
| `--output_dir` | string | Absolute path for the export directory. Defaults to <main-project-dir>/reports/mass_scouting/. |

Example:
```bash
llm-ext scout export --db_path /tmp/scout.db --job_id scout-audit --format csv
```

### `llm-ext scout jobs`

- Usage: `llm-ext scout jobs [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

List every mass-scouting job in a DB with key metadata (fieldset, model, ok/total, cost, started_at). Use this to discover what work has already been done before starting a new scout.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--json` | boolean | Return as a JSON array instead of a table. |

Example:
```bash
llm-ext scout jobs --db_path /tmp/scout.db
```

### `llm-ext scout audit-sample`

- Usage: `llm-ext scout audit-sample [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Pick N random results from a finished job and print them ALONGSIDE the cached file body. The standard human-trust check: did the model actually understand the file? Returns a structured `samples` array in JSON mode for downstream review pipelines.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--body_truncate` | number | Per-body excerpt cap in chars. Default: 1000. |
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--job_id` | string | (required) Stable job identifier (e.g. 'scout-2026-05-06-audit'). Re-running scout with the same id... |
| `--json` | boolean | Return JSON instead of human-readable markdown. |
| `--sample` | number | How many random samples to pull. Default: 5. |

Example:
```bash
llm-ext scout audit-sample --db_path /tmp/scout.db --job_id scout-audit --sample 5
```

### `llm-ext scout body-get`

- Usage: `llm-ext scout body-get [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Print the cached file body for a given short_id. The body cache is the read-once-from-disk source of truth — exposing it here lets follow-up subagents re-analyse a file without touching the filesystem.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Absolute path to the SQLite registry. Created if missing. All sub-commands of a single... |
| `--short_id` | number | (required) Positive integer short_id from mass_scout_register. |

Example:
```bash
llm-ext scout body-get --db_path /tmp/scout.db --short_id 1
```

### `llm-ext scout build-fieldset`

- Usage: `llm-ext scout build-fieldset [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Compose a JSON fieldset from --field shorthand tokens. Use this when you know the shape you want and prefer one-liner field defs over hand-writing JSON. Forms supported by the shorthand parser: `name:bool=desc`, `name:string(120)=desc`, `name:enum(a,b,c)=desc`, `name:array_string(8)=desc`, `name:array_enum(a,b,c)(8)=desc`, `name:int(1-10)=desc`, `name:number(0.0-1.0)=desc`. Use array_enum (not array_string) for a fixed tag vocabulary so the model cannot drift off your allowed values.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--field` | array | (required) One or more shorthand tokens like 'is_async:bool=true if file uses async/await'. |
| `--name` | string | (required) Fieldset name (lowercase identifier). |
| `--out` | string | Optional path to write the JSON fieldset (otherwise stdout). |

Example:
```bash
llm-ext scout build-fieldset --name has_async --field "is_async:bool=true if file uses async/await" --out /tmp/has_async.json
```

### `llm-ext scout propose-fieldset`

- Usage: `llm-ext scout propose-fieldset [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: scouting

Ask the LLM to propose a fieldset JSON for a natural-language goal, optionally seeded with sample files. The biggest UX cliff in mass-scouting is 'what fields do I write?' — this tool resolves it. Returns the validated fieldset JSON.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--allow_untested_model` | boolean | Force ONE invocation with a model that has no scout-accuracy PASS. Runs a structural schema... |
| `--goal` | string | (required) One-sentence statement of what the user wants to find/extract. |
| `--model` | string | Must be scout-accuracy-verified (ledger PASS under the current dataset hash) — see the... |
| `--out` | string | Optional path to write the JSON fieldset (otherwise stdout). |
| `--samples` | array | Optional list of sample file paths to seed the model with real content. |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scout propose-fieldset --goal "find files that read environment variables" --out /tmp/env.json
```

### `llm-ext scout diff`

- Usage: `llm-ext scout diff [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

Compare two scout jobs row-by-row and report which fingerprints are only in one, only in the other, identical, or have changed fields. Use to confirm that a re-scout (after a fieldset tweak, model swap, or partial re-register) actually changed the data you expected — and didn't silently regress other rows. Output is a human summary by default, JSON with `json: true`.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--db_path` | string | (required) Path to the SQLite DB. |
| `--from_job` | string | (required) Baseline job_id. |
| `--json` | boolean | Return JSON instead of human-readable summary. |
| `--to_job` | string | (required) Comparison job_id. |

Example:
```bash
llm-ext scout diff --db_path /tmp/scout.db --from_job scout-audit --to_job scout-audit-2
```

### `llm-ext scout chain`

- Usage: `llm-ext scout chain [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: scouting

Run a second scout pass on the subset of rows from a prior job that match a JSON-extract filter. Use to drill deeper into a high-value slice (e.g. files where job-A flagged severity='critical') without re-scouting the whole tree. The new job uses a fresh fieldset, so you can extract DIFFERENT fields from the matched subset. Filter syntax: '$.path:OP:value' where OP is one of =, !=, >, >=, <, <=, LIKE (e.g. '$.severity:=:critical', '$.score:>=:0.8', '$.summary:LIKE:auth%').

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--allow_untested_model` | boolean | Force ONE invocation with a model that has no scout-accuracy PASS. Runs a structural schema... |
| `--db_path` | string | (required) Path to the SQLite DB. |
| `--filter` | string | (required) JSON-extract filter using '$.path:OP:value' syntax. Operators: =, !=, >, >=, <, <=, LIKE. |
| `--max_retries` | number | Per-file retries. Default 1. |
| `--model` | string | Must be scout-accuracy-verified (ledger PASS under the current dataset hash) — see the... |
| `--new_fields_file` | string | (required) Path to the new fieldset JSON for this job. |
| `--new_job_id` | string | (required) Job id for the new chained scout. Must not already exist. |
| `--source_job` | string | (required) Job to chain from (its results are the input set). |
| `--workers` | number | Concurrency. Default 4. |
| `--profile` | string | Selects the settings profile for this invocation only (a key under `profiles:` in ~/.llm-externalizer/settings.yaml). When omitted, the `active:` key in settings.yaml decides, and 'free' is used when that is missing too. Never modifies settings.yaml. An unknown name fails fast and lists the available profiles. |

Example:
```bash
llm-ext scout chain --db_path /tmp/scout.db --source_job scout-audit --new_job_id scout-audit-2 --filter "$.is_async:=:true" --new_fields_file /tmp/second.json
```

### `llm-ext scout list-fieldsets`

- Usage: `llm-ext scout list-fieldsets [--flag value ...]`
- Bare argument: none (everything goes through flags)
- Accepted profile types: any

List the plugin-shipped fieldsets that other tools accept as fields_file: 'bundled:<name>'. The biggest UX cliff in mass-scouting is 'what fields do I write?' — these standard sets (code-audit, skill-audit, security-audit, pr-review) cover the common cases with no fieldset authoring required.

| Flag | Type | Meaning (as printed by --help; long text is truncated there) |
|---|---|---|
| `--json` | boolean | If true, return a JSON list of {name, path, fields[]} objects so a caller can pick the right... |

Example:
```bash
llm-ext scout list-fieldsets --json true
```
