---
name: llm-externalizer-mass-scout-preclassify
description: |-
  Run the cheap script-only file classifier across registered files. Assigns
  each file a bucket (binary / sourcecode / documentation / config /
  log_to_classify / rules_to_eval / has_frontmatter / unknown). Phase 2 of
  the pipeline.
allowed-tools:
  - Bash
argument-hint: "--db-path <path> [--reclassify] [--limit <n>]"
effort: low
---

# Mass-scout — preclassify

Cheap, script-only classifier. Reads body bytes from the cache (no disk
re-read), assigns each file a bucket plus optional language and format
tags. The bucket is used downstream by `estimate` and `scout` to filter
the workload (e.g. "scout only sourcecode files").

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | The registry from `mass-scout-register` |
| `--reclassify` | no | Re-run the classifier on already-classified rows (default: false) |
| `--limit <n>` | no | Process at most N rows. Useful for incremental runs. |

## Buckets

| Bucket | Meaning |
|---|---|
| `binary` | Null bytes detected — never sent to LLM |
| `rules_to_eval` | CLAUDE.md, AGENTS.md, `.cursorrules`, anything under a `/rules/` segment |
| `has_frontmatter` | Markdown with leading `---…---` block (often skill specs) |
| `documentation` | Markdown without frontmatter |
| `sourcecode` | Recognised programming-language extension |
| `config` | json / yaml / toml / ini / `.env` |
| `log_to_classify` | `*.log` / `*.out` |
| `unknown` | Fallthrough — scout sees these too |

## Output

One-line summary plus the by-bucket breakdown:

```
total=<N>
classified=<C>
skipped_already=<S>
no_body=<E>
by_bucket: sourcecode=<a>, documentation=<b>, config=<c>, ...
```

## Example

```
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-preclassify --db-path /tmp/scout.db
```

Classifies every freshly-registered file in `/tmp/scout.db` into its
bucket and prints the by-bucket breakdown. Add `--reclassify` to re-run
over already-classified rows, or `--limit 500` to process incrementally.

## Token frugality

Body bytes are read from `file_body_cache` only — disk is never
re-touched. This is part of the §15 directive ("do not waste tokens:
avoid having to repeat or read things twice").
