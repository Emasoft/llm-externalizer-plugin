---
name: llm-externalizer-compact-session
description: |-
  Compact any Claude Code session transcript to a compaction-style summary at $0,
  via `llm-ext session compact`. Accepts `<project-slug>/<session-id>.jsonl` for a
  session in ANY project, a bare session id for the current one, or nothing at all
  to compact this project's most recent session. Use when asked to compact, compress,
  or summarize a session/transcript/.jsonl, or to shrink a session before /clear.
argument-hint: "[<project-slug>/<session-id>.jsonl | <session-id> | (empty = current project's latest)]"
effort: low
user-invocable: true
---

# Compact a session transcript

`llm-ext session compact` streams a `.jsonl` transcript through a map-reduce summarizer
using only FREE models — $0 by construction, and it never loads the file into memory.

## Resolve the argument to a target

| the user gave | what to pass | why |
|---|---|---|
| `<slug>/<session-id>.jsonl` | `--transcript ~/.claude/projects/<slug>/<session-id>.jsonl` | **`--session_id` only resolves inside the CURRENT project**, so any other project needs the full path |
| a bare session id / uuid | `--session_id <id>` | resolves to `~/.claude/projects/<current-slug>/<id>.jsonl` |
| an absolute `.jsonl` path | `--transcript <path>` | wins over everything |
| nothing | *(no target flag)* | defaults to the most recently modified transcript of the current project |

A project slug is its absolute path with every non-alphanumeric character replaced by `-`
(e.g. `~/Code/foo` → `-Users-me-Code-foo`). To find one, list `~/.claude/projects/`.
The CURRENT session's own transcript is a valid target — compacting the conversation you
are in is the point when preparing for `/clear`.

## Run it

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" session compact <target flags> [-o <dir>]
```

It prints the report PATH to stdout — Read that, do not echo the transcript. With no `-o`
the report lands in `<project-root>/reports/llm-externalizer/`.

## What to tell the user

The report path, and the fact that it is a nine-section compaction summary with user
messages preserved VERBATIM. Do not paste the summary body into the conversation unless
asked — the whole point is keeping it out of context.

## Expectations that prevent false alarms

- **It is slow on free models: ~10–25 minutes for a large transcript, and per-chunk latency
  is wildly variable (measured 91–1478 s).** That is queue contention, not a hang. Do NOT
  "fix" it by lowering `--chunk_timeout_s`: that deadline is PER ATTEMPT, and setting it
  below the working band multiplies cost instead of bounding it.
- **Re-running is cheap.** Compaction is incremental: an unchanged transcript prefix reuses
  prior chunk summaries and only new turns are sent. A first run on a session is expensive;
  a run five minutes later costs only the new turns. Run it on a cadence rather than once
  at the moment you need it.
- A truncated or rewritten transcript correctly forces a full restart — it never silently
  reuses summaries against a changed prefix.
- Give the Bash call a 20-minute timeout, or run it in the background.

## Useful flags

`--prune aggressive` (default) drops tool-result payloads and pasted file contents;
`--stdout` prints the summary text instead of a report path; `--resume` requires an
existing checkpoint and fails fast if none matches.
