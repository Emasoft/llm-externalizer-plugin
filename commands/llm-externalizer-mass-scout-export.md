---
name: llm-externalizer-mass-scout-export
description: |-
  Dump every result row of a mass-scouting job to JSONL or CSV under
  reports/mass_scouting/. Useful for follow-up analysis in pandas, jq, etc.
allowed-tools:
  - Bash
argument-hint: "--db <path> --job-id <id> [--format jsonl|csv]"
effort: low
---

# Mass-scout — export

Iterate every `mass_scout_results` row for a given `--job-id` and write
them to a single JSONL or CSV file under
`<main-project-dir>/reports/mass_scouting/`. The main project dir is
`$CLAUDE_PROJECT_DIR` (the directory Claude Code is operating in), used
verbatim; it falls back to the process cwd and is **never** derived from
git. Override with `--output-dir <path>`. The written filename is
`<TIMESTAMP>-export-<job-slug>.<format>`, and the absolute path is
returned to the caller so they can route it to the next stage of their
workflow.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db <path>` | yes | The registry |
| `--job-id <id>` | yes | The job to export |
| `--format jsonl\|csv` | no | Default: `jsonl` |
| `--output-dir <path>` | no | Override the default `<main-project-dir>/reports/mass_scouting/` output directory (absolute, or relative to cwd) |

## Output

```
job_id=<id>
format=jsonl|csv
rows=<N>
path=<absolute path to the export file>
```

## JSONL format

One JSON object per line — same shape as the SQLite `mass_scout_results`
row:

```json
{"job_id":"...","file_fingerprint":"...","short_id":1,"result_json":"...","raw_response":"...","repaired":0,"attempts":1,"cost_usd":0.000_005,"enriched_at":"2026-05-06T..."}
```

## CSV format

Columns:
`job_id, file_fingerprint, short_id, result_json, repaired, attempts, cost_usd, enriched_at`

`result_json` is the embedded JSON (already a string). Cells that
contain commas, quotes, or newlines are quoted and double-escaped.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-export --db-path /tmp/scout.db --job-id job-2026-05-24 --format csv
```

Exports every result row of `job-2026-05-24` to a CSV under
`<main-project-dir>/reports/mass_scouting/`, then returns the path so you
can open it in pandas or a spreadsheet.

## Tips

- `jq -c '.result_json | fromjson | .is_async' <file>.jsonl` —
  extract one field across all rows.
- Pipe CSV into pandas: `pd.read_csv(...)` then `pd.json_normalize(...,
  record_path=None, meta=...)` on `result_json` to expand the dynamic
  fieldset into proper columns.
