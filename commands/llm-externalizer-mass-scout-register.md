---
name: llm-externalizer-mass-scout-register
description: |-
  Register a folder (or explicit file list) into the mass-scouting SQLite
  registry. Phase 1 of the mass-scouting pipeline.
allowed-tools:
  - Bash
argument-hint: "--db <path> --root <folder> [--git-diff <ref>] [--no-gitignore] | --files <a,b,c> [--extensions .ts,.md] [--exclude-dirs ...]"
effort: low
---

# Mass-scout — register

Walk a folder (or accept an explicit `file_paths` list) and write every
file body into the SQLite body cache. Files larger than the model's
register cap (default 50% of context) are recorded in the skipped log.
Idempotent — re-registering the same content returns the existing
short_id.

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db <path>` | yes | Absolute path to the SQLite registry (created if missing) |
| `--root <folder>` | one of | Walk this folder (recursive) |
| `--files <a,b,c>` | one of | Explicit comma-separated paths (mutually exclusive with `--root`) |
| `--git-diff <ref>` | one of | Use `git diff --name-only --diff-filter=ACMR <ref>...HEAD` rooted at `--root` to register only added/modified files since `<ref>`. Incremental scouts. |
| `--extensions <list>` | no | Filter the walk to these extensions (e.g. `.ts,.tsx,.md`) |
| `--exclude-dirs <list>` | no | Extra dir names to skip beyond the built-ins |
| `--no-gitignore` | no | Bypass `.gitignore` filtering. Default: gitignored files are skipped. |
| `--model <id>` | no | Model id (default: qwen/qwen-2.5-7b-instruct) — controls the register cap |
| `--max-context-pct-register <0..1>` | no | Override the default 50% cap |

The walk skips: `.git`, `node_modules`, `.venv`, `dist`, `build`,
`.idea`, `.vscode`, `tmp`, `vendor`, `__pycache__`, `target`,
`.next`, `.cache`, `.turbo`, `out`. Gitignored paths are also skipped
unless `--no-gitignore` is passed (the default uses
`git ls-files --cached --others --exclude-standard` to honour the repo's
own ignore rules).

## Output

A one-line counter summary:

```
db=<path>  registered=<N>  already_registered=<R>  skipped_too_big=<K>  skipped_read_error=<E>  total_paths=<T>
```

## Next steps

After register, run `/llm-externalizer:llm-externalizer-mass-scout-preclassify`
to bucket the files, then `/llm-externalizer:llm-externalizer-mass-scout-estimate`
to preview cost, then `/llm-externalizer:llm-externalizer-mass-scout` to run
the LLM extraction.

See the `llm-externalizer-mass-scouting` skill for the full pipeline.

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-register --db-path /tmp/scout.db --folder-path /path/to/repo/src --extensions .ts,.tsx,.md
```

Walks `/path/to/repo/src`, caches every `.ts`/`.tsx`/`.md` file body into
`/tmp/scout.db` (skipping gitignored paths and the built-in vendor dirs),
and prints the registered / skipped counters. For an incremental scout of
just the files changed since `main`, use `--git-diff main` instead of a
plain `--root` walk.
