---
name: llm-externalizer-mass-scout-chain
description: |-
  Run a second scout pass on the subset of rows from a prior job that
  match a JSON-extract filter. Drills deeper into a high-value slice
  without re-scouting the whole tree.
allowed-tools:
  - Bash
argument-hint: "--db-path <path> --source-job <id> --new-job-id <id> --new-fields-file <path> --filter \"$.path:OP:value\" [--model <id>] [--workers <N>] [--max-retries <N>]"
effort: medium
---

# Mass-scout — chain

Phase 2 of a two-stage scout. Reads a completed job's results, picks the
subset whose `result_json` matches a filter expression, then runs a new
scout on JUST those files using a fresh fieldset. The new job's
results sit alongside the old job's in the same DB.

Use to drill into a high-value slice (e.g. files where job-A flagged
`severity=critical`) and extract DIFFERENT fields from them, without
re-scouting the whole tree.

## Filter syntax

`$.path:OP:value` where:

| Part | Meaning |
|---|---|
| `$.path` | JSON1 path into `result_json` (e.g. `$.severity`, `$.is_async`, `$.score`) |
| `OP` | One of `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE` |
| `value` | `true` / `false` / `null` (literal), `42` / `3.14` (number), anything else (string) |

Examples: `$.severity:=:critical` · `$.score:>=:0.8` · `$.summary:LIKE:auth%`.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | Absolute path to the SQLite registry |
| `--source-job <id>` | yes | The job to chain from (its results are the input set) |
| `--new-job-id <id>` | yes | The job_id for the new chained scout. Must not already exist in the DB |
| `--new-fields-file <path>` | yes | Path to the new fieldset JSON used by the chained scout |
| `--filter "..."` | yes | JSON-extract filter (see syntax above) |
| `--model <id>` | no | Model id for the chained scout. Defaults to the active profile's primary model (overridden to the active free model when `free_only` is set) |
| `--workers <N>` | no | Concurrency. Default: 4 |
| `--max-retries <N>` | no | Per-file retries. Default: 1 |

## Output

A standard mass-scout markdown report under
`<main-project-dir>/reports/mass_scouting/`, the same shape as a fresh
scout. The report path + a counter line (`chained=N from=<src>
matched=K`) are returned to the caller.

## Invocation

Like `mass-scout`, a chained pass runs one LLM call per matched file and
can take tens of minutes on a large subset. Invoke with an explicit
20-minute Bash `timeout`, or with `run_in_background: true`, so the turn
doesn't block waiting on the whole chain.

## Example

```
timeout 1200 ${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-chain \
  --db-path /tmp/scout.db \
  --source-job initial-audit \
  --new-job-id critical-deep-dive \
  --new-fields-file /tmp/critical.fields.json \
  --filter "\$.severity:=:critical" \
  --workers 8
```

Selects every result from `initial-audit` where `result_json.severity ==
"critical"` and re-scouts those files with the deeper fieldset in
`/tmp/critical.fields.json`. The new rows land under `job_id=critical-
deep-dive` in the same DB.

## Errors

- `--new-job-id` already exists → exit 1 (chain refuses to overwrite).
- Filter matched zero rows → exit 0 with `matched=0 — nothing to chain`
  (not an error; the source job simply had no qualifying files).
- Invalid filter expression → exit 1 with the parser diagnostic.
