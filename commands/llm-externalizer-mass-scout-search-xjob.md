---
name: llm-externalizer-mass-scout-search-xjob
description: |-
  Cross-job federated search across multiple mass-scouting jobs. Same
  query semantics as mass-scout-search; results are tagged with the
  originating job_id and merged by bm25 rank.
allowed-tools:
  - Bash
argument-hint: "--db-path <path> --job-ids id1,id2,... [--query \"...\"] [--regex \"...\"] [--filter '...'] [--json]"
effort: low
---

# Mass-scout — search-xjob

Federated search across two or more `--job-ids`. Runs `mass-scout-search`
on each job in turn and merges the results, sorted by FTS5 bm25 rank
(lower = better) where applicable. Each hit carries its originating
`job_id` so the caller can route follow-ups.

Use cases:

- "Across both my v1 and v2 scout runs of this codebase, find every
  async React file"
- "Across all my scouts of different repos, find any AWS-key smell"
- "Compare two periods of activity by querying both jobs at once"

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | The registry |
| `--job-ids <id1,id2,...>` | yes | Comma-separated list of job_ids |
| `--query "..."` | maybe | FTS5 query OR named-pattern query |
| `--regex "..."` | maybe | Explicit regex pattern |
| `--force-llm` | no | Suppress the regex bypass |
| `--force-regex` | no | Force regex mode |
| `--filter '...'` | no | Structured filter (same syntax as mass-scout-search) |
| `--limit-per-job <n>` | no | Per-job hit cap before merging. Default: 100 |
| `--limit-merged <n>` | no | Final cap on the merged hit list. Default: 200 |
| `--json` | no | Return results as JSON instead of a table |

## Output

Default: header line plus one entry per hit:

```
mode=<mode>  jobs=<id1,id2>  total_examined=<N>
hits=<K>

[<job_id>] <short_id> <file_path> :: <snippet>
[<job_id>] <short_id> <file_path> :: <snippet>
...
```

With `--json`, returns the full `XjobSearchResponse` envelope including
`per_job` breakdown (`{<job_id>: {mode, total_examined, hits}}`).

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-search-xjob --db-path /tmp/scout.db --job-ids job-v1,job-v2 --query "async" --limit-merged 100
```

Searches both `job-v1` and `job-v2` for files matching `async`, merges the
hits by bm25 rank (capped at 100), and tags each hit with the job it came
from. Add `--json` to get the structured `per_job` breakdown for routing.

## Mode resolution

Modes are chosen per-job. The response's top-level `mode` is the most
specific common mode: `regex` wins if any job took the bypass, then
`combined`, then `fts`, then `structured`. The mode is informational —
each hit carries its own per-job mode in the JSON output.
