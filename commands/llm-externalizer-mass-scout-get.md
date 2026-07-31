---
name: llm-externalizer-mass-scout-get
description: |-
  Print one file row from the mass-scouting registry by short_id.
  Optionally include the result row for a specific job_id.
allowed-tools:
  - Bash
argument-hint: "--db <path> --short-id <n> [--job-id <id>]"
effort: low
---

# Mass-scout — get

Look up a single file's metadata by its `short_id` (the auto-incremented
integer assigned at registration time). Useful for drilling into a hit
returned by `mass-scout-search`, where each result row carries the
`short_id` but you want the full file metadata + the per-job result JSON.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db <path>` | yes | The registry |
| `--short-id <n>` | yes | Positive integer short_id |
| `--job-id <id>` | no | If supplied, includes the result row from `mass_scout_results` |

## Output

A pretty-printed JSON object: every column from `file_short_id` (path,
fingerprint, source_root, basename, size, classifier_bucket, language,
format, frontmatter flag, created_at). When `--job-id` is set, a nested
`result` object is appended with `result_json`, `repaired`, `attempts`,
`cost_usd`, `enriched_at` from `mass_scout_results`.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-get --db-path /tmp/scout.db --short-id 42 --job-id job-2026-05-24
```

Prints the full file-metadata row for `short_id=42` plus the nested
`result` object extracted by `job-2026-05-24`. Drop `--job-id` to see just
the file metadata.

## Errors

- Unknown short_id → exit 1 with `no row with short_id=<n>`
- Non-positive short_id → exit 1 with usage error
