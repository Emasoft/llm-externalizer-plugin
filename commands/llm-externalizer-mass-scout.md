---
name: llm-externalizer-mass-scout
description: |-
  Run the LLM scout end-to-end on every eligible file. Compiles the
  fieldset to a JSON Schema, fans calls out via the worker pool, repairs
  + validates each response, persists to SQLite, writes a markdown report.
  Phase 4 of the pipeline.
allowed-tools:
  - Bash
argument-hint: "--db <path> --fields-file <json> --job-id <id> --source-root <path> [--workers N] [--bucket <name>]"
effort: high
---

# Mass-scout — scout

The main LLM-driven phase. For every eligible file (under the scout cap,
not already done for this `job_id`):

1. Build the system prompt + user message (`FILE: <basename>\n\nCONTENT:\n<body>`).
2. POST to OpenRouter with `response_format: {type: "json_schema", json_schema: <compiled>}`.
3. Parse the response; run `repair()` to fix structural drift (missing keys, off-cap strings, near-miss enum values, out-of-range numbers).
4. Run the required-keys validator. On failure, retry once with the validation error fed back into the next prompt.
5. Insert into `mass_scout_results` + the standalone FTS5 table.

When all files are done, render a markdown report to
`<main-project-dir>/reports/mass_scouting/<TIMESTAMP>-scout-<slug>.md`
(the main project dir is `$CLAUDE_PROJECT_DIR`, then cwd — never derived from git).

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db <path>` | yes | The registry |
| `--fields-file <json>` | yes | JSON fieldset path OR `bundled:<name>` shorthand (`code-audit`, `skill-audit`, `security-audit`, `pr-review`) |
| `--job-id <id>` | yes | Stable job identifier — re-run with the same id to resume |
| `--source-root <path>` | yes | Original folder the files came from (recorded on the job) |
| `--model <id>` | no | Default: qwen/qwen-2.5-7b-instruct |
| `--workers <n>` | no | Concurrent OpenRouter calls. Default: 16 |
| `--max-retries <n>` | no | Per-file retry budget excluding the first attempt. Default: 1 |
| `--bucket <name>` | no | Only scout files in this preclassifier bucket |
| `--no-smoke-test` | no | Skip the 5-file sequential smoke test |
| `--no-resume` | no | Re-process files even if they already have a result row |
| `--max-context-pct-scout <0..1>` | no | Override the default 40% scout cap |
| `--output-dir <path>` | no | Directory for the markdown report. Default `<main-project-dir>/reports/mass_scouting/` (anchored on `$CLAUDE_PROJECT_DIR`, then cwd — never git). |
| `--live-context` | no | Query OpenRouter for the active provider's real `context_length` and override KNOWN_PRICING. Recommended when you don't know whether your account routes to a smaller-cap endpoint (e.g. 32K vs 128K). Requires `$OPENROUTER_API_KEY`. |

## Pre-flight

ALWAYS run `mass-scout-estimate` first with the same `--fields-file` and
`--budget-usd` value. If the gate flips to `budget_allowed=false`, do
NOT run `mass-scout` — surface the cost to the user and let them decide.

## Invocation

Run via the CLI. This phase can take TENS OF MINUTES for large corpora
(one LLM call per file, fanned out across `--workers`) — invoke it with
an explicit 20-minute Bash `timeout`, or with `run_in_background: true`,
so the turn doesn't block waiting on the whole scout:

```bash
timeout 1200 ${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout \
  --db-path ./scout.sqlite \
  --fields-file bundled:code-audit \
  --job-id audit-1 \
  --source-root ./src \
  --workers 24
```

Re-invoking with the same `--job-id` resumes — already-scouted files
are skipped, so a `timeout`-killed run can simply be re-run.

## Output

```
job_id=<id>
files_total=<N>
files_ok=<K>
files_failed=<F>
files_skipped_too_big=<S>
retries=<R>
cost_usd=$<X>
report=<absolute path to .md report>
```

Return the `report=` path to the user — that's the deliverable.

## Resume

Re-running with the same `--job-id` skips files that already have a
result row. Combined with the cap-skipped log, you can iteratively trim
oversize files and re-run until every eligible file is scouted.

## Smoke test

By default the first 5 files run sequentially. If any of them throws
(HTTP 400, transport error, JSON parse failure, repeated validate
failure), the run aborts with that file's path in the error message.
This catches bad fieldset / model misroutes / context-cap mistakes early
without burning the full budget.

## Failure handling

Per-file failures are logged in `mass_scout_skipped` with the error
reason. The run completes; `files_failed=<F>` reports the count. To see
the exact errors, query the skipped log via the `--db` directly or run
the `mass-scout-search` sub-command with `--filter '$.short_id:>:0'`.

## Environment

Set `$OPENROUTER_API_KEY` (or configure the plugin's
`userConfig.openrouter_api_key`) before running.

## Usage example

```
# Scout every eligible file with the bundled code-audit fieldset, 24 workers.
# (Always run mass-scout-estimate with the same --fields-file first.)
timeout 1200 ${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout --db-path ./scout.sqlite --fields-file bundled:code-audit --job-id audit-1 --source-root ./src --workers 24
```

When the run finishes, return only the `report=` path to the user — that is
the deliverable. Re-invoking with the same `--job-id` resumes (already-scouted
files are skipped).
