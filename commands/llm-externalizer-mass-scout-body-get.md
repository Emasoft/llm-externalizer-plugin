---
name: llm-externalizer-mass-scout-body-get
description: |-
  Print the cached file body for a given short_id. The body cache is the
  read-once-from-disk source of truth — exposing it lets follow-up
  subagents re-analyse a file without touching the filesystem.
allowed-tools:
  - Bash
argument-hint: "--db-path <path> --short-id <n>"
effort: low
---

# Mass-scout — body get

Print the file body cached in the mass-scout registry for a single
`short_id`. The body was read from disk at register time; this lets
follow-up agents reason about the file without re-reading from the
filesystem (no race against in-progress edits, no double I/O cost).

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | Absolute path to the SQLite registry |
| `--short-id <n>` | yes | Positive integer assigned by `mass_scout_register` |

## Output

The raw file body, exactly as it was when registered, written to stdout.
Use shell redirection or `--output-dir`-aware downstream tools to pipe
it elsewhere.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-body-get --db-path /tmp/scout.db --short-id 42
```

Prints the body that was registered under `short_id=42`. Combine with
`mass_scout_search` (which returns short_ids in its hit list) to drill
from a query result into the underlying source.

## Errors

- Unknown short_id → exit 1 with `no body for short_id=<n>` and a hint
  to re-run register if the row was expected.
- Non-positive `--short-id` → exit 1 with a usage error.
