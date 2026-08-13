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

### When the summary MUST eventually exist

Add `--until-done`. Without it the command is checkpoint-and-stop by design: a chunk gets
its retry budget, a dead or quota-capped model is demoted to the next ranked free one, and
when those run out the command FAILS and tells you to re-run. That is the right default for
an interactive run — it reports the problem instead of sitting on it — and the wrong one for
an unattended compaction.

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" session compact <target flags> --until-done
```

Retrying is cheap and correct because of the checkpoint: every pass keeps the chunks that
already landed and only redoes what did not, so N passes converge instead of repeating work.
Backoff is 30s doubling to a 15-minute cap; when the failure names an exhausted daily quota
the wait is capped at the next 00:00 UTC reset instead, because that is when the free tier
actually returns. A bad argument (a transcript path that does not exist, an unknown profile)
still fails immediately — `--until-done` retries the compaction, not your typo.

Belt and braces, if the caller must survive the process being killed as well:

```bash
until "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" session compact <target flags>; do sleep 60; done
```

Same convergence property, one level up. Use the flag inside a single invocation, the loop
when something external may kill the process.

## What to tell the user

The report path, the fact that it is a nine-section compaction summary with user messages
preserved VERBATIM, and the **size reduction**. Do not paste the summary body into the
conversation unless asked — the whole point is keeping it out of context.

The command prints the reduction to stderr and embeds the same line in the report header:

```
Size: 2.08 MB (2,179,678 B) transcript → 13.9 KB (14,242 B) summary — 99.35% reduction; pruned to 812 KB before summarizing
```

Raw byte counts sit beside the human-readable sizes on purpose — the human form is what you
read, the exact number is what you compare across runs. A summary that came out LARGER than
its transcript says so explicitly; that is the one case where running the command was not
worth it, so it is never rounded away.

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

`--until-done` never gives up (see above). `--max-retries-per-chunk N` raises how many
times ONE chunk may be re-attempted on the SAME model (default 2, i.e. 3 attempts) — it
covers provider hiccups and rate-limit backoff, and does NOT cover a delisted or
quota-exhausted model, which is demoted and replaced regardless of this number. Flags accept
either spelling: `--until-done` and `--until_done` are the same flag.
