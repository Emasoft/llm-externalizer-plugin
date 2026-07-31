---
name: llm-externalizer-mass-scout-jobs-list
description: |-
  List every mass-scouting job in a DB with key metadata (fieldset, model,
  ok/total, cost, started_at). Run this BEFORE starting a new scout to
  discover what work already exists in the registry.
allowed-tools:
  - Bash
argument-hint: "--db <path> [--json]"
effort: low
---

# Mass-scout — jobs list

Enumerate every job recorded in a mass-scouting SQLite registry. Quick
audit for "what scouts have I already run against this DB?" before
spending time / tokens on a new one. Read-only.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db <path>` | yes | Absolute path to the SQLite registry |
| `--json` | no | Return a JSON array of job objects instead of a human-readable table |

## Output

Default: a markdown-aligned table with columns:
`job_id`, `fieldset`, `model`, `ok`, `total`, `cost_usd`, `started_at`.

With `--json`: the same fields as a JSON array, one object per job, for
downstream programmatic use.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-jobs-list --db-path /tmp/scout.db
```

Lists every job in `/tmp/scout.db`. Add `--json` to pipe the result
through `jq`:

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-jobs-list --db-path /tmp/scout.db --json
```

## Errors

- DB path missing or unreadable → exit 1 with a one-line diagnostic.
- Schema mismatch (DB created by a much older version) → exit 1 with the
  remediation hint `re-register the corpus with mass_scout_register`.
