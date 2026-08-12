---
name: llm-externalizer-mass-scout-audit-sample
description: |-
  Pull N random results from a finished mass-scout job alongside the
  cached file body. The standard human-trust check: did the model
  actually understand the file?
allowed-tools:
  - Bash
argument-hint: "--db-path <path> --job-id <id> [--sample <N>] [--body-truncate <chars>] [--json]"
effort: low
---

# Mass-scout — audit sample

Pick N random `(file, result_json)` rows from a completed job and print
them next to the cached file body. Use after a scout finishes to spot-
check whether the LLM's output reflects the real content — or whether
the fieldset / model needs a rethink before you trust the rest of the
job.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | Absolute path to the SQLite registry |
| `--job-id <id>` | yes | The job whose results to sample |
| `--sample <N>` | no | How many random rows to pull. Default: 5 |
| `--body-truncate <chars>` | no | Per-body excerpt cap, in chars. Default: 1000 |
| `--json` | no | Return a structured `samples` array (one object per row, with `path`, `result_json`, `body_excerpt`) instead of human-readable markdown |

## Output

Default: a markdown block per sample with the file path, the truncated
body excerpt, and the `result_json` the model emitted. Easy to scan by
eye.

With `--json`: a top-level object `{ job_id, samples: [...] }` where
each sample carries the parsed `result_json` plus the body excerpt, for
downstream review pipelines.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-audit-sample --db-path /tmp/scout.db --job-id job-2026-05-24 --sample 8
```

Pulls 8 random rows from `job-2026-05-24` and prints them with their
file bodies. Add `--json` to feed the samples into another agent for
LLM-as-judge scoring.

## Errors

- Unknown job_id → exit 1 with `no job with id=<id>` and a hint to run
  `mass_scout_jobs_list`.
- Empty job (no results yet) → exit 1 with `job has 0 results`.
