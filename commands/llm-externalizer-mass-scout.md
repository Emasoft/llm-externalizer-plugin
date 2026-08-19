---
name: llm-externalizer-mass-scout
description: |-
  Mass-scouting dispatcher — every action of the pipeline in ONE
  command. Bare invocation runs the end-to-end LLM scout (phase 4:
  fieldset -> JSON Schema, worker-pool fan-out, repair + validate,
  SQLite persist, markdown report). Pass an action word for everything
  else (register, estimate, search, export, diff, chain, ...); each
  action maps 1:1 to `bin/llm-ext mass-scout-<action>`.
allowed-tools:
  - Bash
argument-hint: "[action] [flags] — actions: register | preclassify | estimate | (bare = scout run) | search | search-xjob | get | body-get | export | jobs-list | audit-sample | build-fieldset | propose-fieldset | list-bundled-fieldsets | diff | chain"
effort: high
---

# Mass-scout — dispatcher

The FIRST word of the arguments selects the action. Map it to the CLI:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout-<action> <remaining flags>
```

**ALWAYS fold the action word into the hyphenated subcommand — never
pass it through as a positional argument.** `llm-ext mass-scout search …`
(with a space) silently drops the word `search` and runs the bare
end-to-end scout; only the missing required flags stop it. The correct
form is always `llm-ext mass-scout-search …`.

No action word = the **end-to-end scout run** (`llm-ext mass-scout`,
documented below). The flag SSOT for every action is
`bin/llm-ext mass-scout-<action> --help`; the pipeline guide (5 phases,
token-efficiency rules, worked example) is the
`llm-externalizer-mass-scouting` skill.

> Until v13.5.8 each action was its own
> `/llm-externalizer:llm-externalizer-mass-scout-<action>` command; the
> 15 per-action menu entries were collapsed into this dispatcher
> (TRDD-WIO13P1P). The `llm-ext mass-scout-*` CLI subcommands are
> unchanged — only the slash-command surface moved.

## Actions

| Action | Flags | Purpose → output |
|---|---|---|
| `register` | `--db-path <path> --folder-path <folder> [--git-diff <ref>] [--no-gitignore]` \| `--file-paths <a,b,c> [--extensions .ts,.md] [--exclude-dirs ...]` | Walk a folder / take a file list, store every body in the SQLite cache (honors `.gitignore`) → counter line `registered=N already=M skipped_too_big=K …` |
| `preclassify` | `--db-path <path> [--reclassify] [--limit <n>]` | Script-only bucket tagger across registered files → counter line per bucket |
| `estimate` | `--db-path <path> --fields-file <json> [--budget-usd N] [--bucket <name>] [--workers N]` | Cost / time / cap-skipped preview for a fieldset; honors `--budget-usd`; `--live-context` queries OpenRouter for the real cap → numbers + per-bucket breakdown |
| *(bare)* | see "End-to-end scout run" below | Run the LLM scout over every eligible file → markdown report under `reports/mass_scouting/` + counter line |
| `search` | `--db-path <path> --job-id <id> [--query "..."] [--regex "..."] [--filter '$.x:=:val'] [--json]` | Per-job search, three modes auto-routed (regex bypass / FTS5 / structured JSON1) → hit list |
| `search-xjob` | `--db-path <path> --job-ids id1,id2,... [--query "..."] [--regex "..."] [--filter '...'] [--json]` | Cross-job federated search → merged hit list |
| `get` | `--db-path <path> --short-id <n> [--job-id <id>]` | Print one file row by `short_id` (+ per-job result with `--job-id`) → JSON row |
| `body-get` | `--db-path <path> --short-id <n>` | Print the cached file body — lets follow-up agents reason about the file without re-reading disk → raw body on stdout |
| `export` | `--db-path <path> --job-id <id> [--format jsonl\|csv]` | Dump every result row of a job under `reports/mass_scouting/` → file path |
| `jobs-list` | `--db-path <path> [--json]` | Enumerate every job in a DB (fieldset, model, ok/total, cost, started_at) — audit "what scouts already ran?" → markdown table or JSON |
| `audit-sample` | `--db-path <path> --job-id <id> [--sample <N>] [--body-truncate <chars>] [--json]` | N random results next to the cached bodies — human-trust check → markdown samples or `samples[]` JSON |
| `build-fieldset` | `--name <id> --field "name:type=desc" [--field "..."] ... [--out <path>]` | Compose a fieldset JSON from shorthand tokens (`name:bool=desc`, `name:enum(a,b,c)=desc`) → validated fieldset JSON |
| `propose-fieldset` | `--goal "..." [--samples a.ts,b.ts,...] [--model <id>] [--out <path>]` | LLM proposes a fieldset for a natural-language goal → validated fieldset JSON |
| `list-bundled-fieldsets` | `[--json]` | Enumerate plugin-shipped fieldsets accepted as `--fields-file bundled:<name>` (`code-audit`, `skill-audit`, `security-audit`, `pr-review`) → list |
| `diff` | `--db-path <path> --from-job <id> --to-job <id> [--json]` | Compare two jobs row-by-row → `only_from` / `only_to` / `identical` / `changed` (+ changed keys) |
| `chain` | `--db-path <path> --source-job <id> --new-job-id <id> --new-fields-file <path> --filter "$.path:OP:value" [--model <id>] [--workers <N>] [--max-retries <N>]` | Re-scout the filter-matched subset of a prior job with a fresh fieldset → new job's report + counter line |

Small read-only actions (`get`, `search`, `jobs-list`, ...) are instant
CLI calls — run them directly. The heavy actions (`bare` scout run,
`chain`) follow the invocation rules below.

## End-to-end scout run (the bare action)

For every eligible file (under the scout cap, not already done for this
`job_id`): build the prompt, POST to OpenRouter with
`response_format: {type: "json_schema", ...}`, `repair()` structural
drift, validate required keys (one retry with the error fed back), and
insert into `mass_scout_results` + FTS5. When all files are done it
renders a markdown report to
`<main-project-dir>/reports/mass_scouting/<TIMESTAMP>-scout-<slug>.md`
(anchored on `$CLAUDE_PROJECT_DIR`, then cwd — never derived from git).

| Flag | Required | Description |
|---|---|---|
| `--db-path <path>` | yes | The registry |
| `--fields-file <json>` | yes | JSON fieldset path OR `bundled:<name>` shorthand |
| `--job-id <id>` | yes | Stable job identifier — re-run with the same id to resume |
| `--source-root <path>` | yes | Original folder the files came from (recorded on the job) |
| `--model <id>` | no | Default: qwen/qwen-2.5-7b-instruct |
| `--workers <n>` | no | Concurrent OpenRouter calls. Default: 16 |
| `--max-retries <n>` | no | Per-file retry budget excluding the first attempt. Default: 1 |
| `--bucket <name>` | no | Only scout files in this preclassifier bucket |
| `--no-smoke-test` | no | Skip the 5-file sequential smoke test |
| `--no-resume` | no | Re-process files even if they already have a result row |
| `--max-context-pct-scout <0..1>` | no | Override the default 40% scout cap |
| `--output-dir <path>` | no | Directory for the markdown report |

### Pre-flight

ALWAYS run the `estimate` action first with the same `--fields-file` and
`--budget-usd`. If the gate flips to `budget_allowed=false`, do NOT run
the scout — surface the cost to the user and let them decide.

### Invocation

This phase can take TENS OF MINUTES for large corpora (one LLM call per
file, fanned out across `--workers`) — invoke with an explicit
20-minute Bash `timeout`, or `run_in_background: true`:

```bash
timeout 1200 ${CLAUDE_PLUGIN_ROOT}/bin/llm-ext mass-scout \
  --db-path ./scout.sqlite \
  --fields-file bundled:code-audit \
  --job-id audit-1 \
  --source-root ./src \
  --workers 24
```

### Output

```
job_id=<id>
files_total=<N>
files_ok=<K>
files_failed=<F>
files_skipped_too_big=<S>
retries=<R>
cost_usd=$<X>
report=<absolute path to .md report>
```

Return the `report=` path to the user — that is the deliverable.

### Resume, smoke test, failures

Re-running with the same `--job-id` skips files that already have a
result row, so a `timeout`-killed run is simply re-run. The first 5
files run sequentially as a smoke test — any throw (HTTP 400, transport
error, JSON parse, repeated validate failure) aborts with that file's
path, catching bad fieldsets / model misroutes before burning budget.
Per-file failures land in `mass_scout_skipped` with the reason; the run
completes and reports `files_failed=<F>` (inspect via the `search`
action with `--filter '$.short_id:>:0'`, or query the DB directly).

### Environment

Set `$OPENROUTER_API_KEY` (or the plugin's
`userConfig.openrouter_api_key`) before running.
