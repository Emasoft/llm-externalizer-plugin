---
name: llm-externalizer-mass-scouting
description: |-
  Use when the user wants to extract structured metadata from many files
  with a cheap LLM. Triggers: "mass scout", "scan many files for X",
  "extract structured data from a folder", "classify all my files",
  "build a queryable index of file metadata", "audit thousands of files",
  "run a fieldset over a codebase", "audit my plugin", "PR review all
  changed files", "security-scan this repo".
argument-hint: "[register | preclassify | estimate | scout | search | search-xjob | get | export | jobs-list | audit-sample | body-get | build-fieldset | propose-fieldset | list-bundled-fieldsets | diff | chain]"
effort: medium
---

# LLM Externalizer — Mass Scouting

Bulk LLM-driven structured-output file analysis. Point a cheap model at
hundreds-to-millions of files; get back a queryable, persistent index of
extractions defined by a per-call **dynamic JSON Schema**.

## When to use

Use mass-scouting when you have a large set of files and need to extract
the SAME structured metadata from every one — categories, flags, tags,
summaries, complexity scores, etc. Examples:

- "For every Python module in this repo, return `{is_async, framework, complexity_1_to_10}`"
- "For every Twitter export file, return `{category, sentiment, has_link}`"
- "For every Markdown skill spec in my collection, return `{kind, max_files_advice, has_examples}`"

The output of a scout run is a SQLite registry you can query with FTS5,
JSON1 path filters, or programmatic regex (the regex bypass — see below).

## When NOT to use

- **Single-file analysis**: read the file directly and reason. mass-scout
  has fixed setup overhead (register + preclassify + estimate) that
  doesn't pay off below ~10 files.
- **Free-form prose answers**: mass-scout REQUIRES a JSON Schema-shaped
  output. If you want "summarize this file" without a schema, use
  `mcp__plugin_llm-externalizer_llm-externalizer__chat` instead.
- **Real-time exploration**: a mass-scout job can take minutes. For
  interactive Q&A use the chat / code_task tools.
- **Tasks needing the orchestrator's reasoning**: mass-scout offloads to
  a small / cheap model (qwen-2.5-7b by default). For tasks that need
  Sonnet/Opus-level reasoning per file, use a real subagent swarm
  instead.
- **Files that change mid-flight**: the body cache snapshots each file at
  register time. If files are changing as you scan (live build output,
  log tails), the snapshot is stale.

## Pipeline

```
register → preclassify → estimate → scout → search
```

| Phase | What it does | LLM? | Cost? |
|---|---|---|---|
| `register` | Walk a folder, hash + cache every file body in SQLite | no | free |
| `preclassify` | Cheap script-only tagger (binary / sourcecode / markdown / config / log / unknown) | no | free |
| `estimate` | Predict tokens + dollars for the upcoming scout. Refuses if over `--budget-usd` | no | free |
| `scout` | Compile a fieldset → JSON Schema → call LLM per file → repair + validate → persist | yes | ~$0.000_03/file at qwen-2.5-7b prices |
| `search` | FTS5 / structured / regex query against the per-job results | usually no | free (regex / FTS) or LLM-cost (forced LLM) |

`search` has a **regex bypass heuristic** — queries like "find all emails",
"urls of domain github.com", "all ipv4", etc. run programmatic regex over
the cached bodies and never hit the LLM.

## How to invoke

The user can run any sub-command via:
- **MCP tool:** `mass_scout_register`, `mass_scout_preclassify`, etc.
- **CLI:** `llm-externalizer mass-scout <subcommand> ...`
- **Slash command:** `/llm-externalizer:llm-externalizer-mass-scout-<subcommand>`

All three paths share the same code (`src/mass_scouting/cli.ts` is the
single source of truth — both MCP tools and slash commands route through
it). See `bin/llm-externalizer mass-scout --help` for every flag.

## Model selection guide

Default: `qwen/qwen-2.5-7b-instruct` (cheapest with adequate JSON-schema
adherence). Use a different model when:

| Goal | Model | Why |
|---|---|---|
| Cheapest per-file (1k+ files) | `qwen/qwen-2.5-7b-instruct` | $0.04/M in, ~95% schema adherence |
| Better short-text accuracy | `google/gemini-2.5-flash` | 2-3× more reliable on short bodies, still cheap |
| Reasoning-heavy fieldsets | `anthropic/claude-haiku-4-5` | Best small-model reasoning; ~10× more expensive |
| Free-tier (slow) | `nvidia/nemotron-3-super-120b-a12b:free` | $0; rate-limited; logged by provider |

Pass via `--model <id>` on `estimate` and `scout` (must match — pricing
is resolved per model). For unknown models, also pass
`--input-price-per-m`, `--output-price-per-m`, and `--context-window`
(or use `--live-context` to query OpenRouter for the real cap).

## Privacy

- File bodies are sent to the configured provider — usually OpenRouter,
  which proxies to a third-party model host. **Do not scout files
  containing secrets, PII, or unreleased proprietary code unless your
  legal/compliance setup permits.** The `:free` tier explicitly logs
  prompts.
- The SQLite registry holds the cached bodies on YOUR disk under the
  user's project — that part stays local.
- The reports under `reports/mass_scouting/` may contain excerpts of
  scouted bodies. `reports/` and `reports_dev/` MUST be in `.gitignore`
  (this is enforced by the global rules — confirm before running).
- Use `--max-context-pct-scout 0.9` only on private code; larger
  payloads = more bytes shipped offsite.

## Defining a fieldset

A fieldset is a JSON file describing what the LLM should extract per
file. Each field has `name`, `description`, and a `type`:

```json
{
  "version": 1,
  "fieldset_name": "ts-code-audit",
  "fields": [
    { "name": "is_async",
      "description": "true if the file declares async / await",
      "type": { "kind": "bool" } },
    { "name": "frameworks",
      "description": "JS/TS frameworks the file uses",
      "type": { "kind": "array_string", "max_items": 8 } },
    { "name": "complexity_1_to_10",
      "description": "subjective complexity 1..10",
      "type": { "kind": "int", "min": 1, "max": 10 } }
  ]
}
```

Supported `kind`s: `bool`, `string` (with `max_length`), `enum`
(with `values`), `array_string` (with `max_items`), `array_enum`
(with `values` + `max_items`, dedup'd), `array_object` (with
`item_fields` + `exact_items` OR `min_items`/`max_items`, **positional,
no dedup** — use this when each item is a typed record), `int`
(`min` / `max`), `number` (`min` / `max`).

### Bundled fieldsets (skip authoring entirely)

Pass `--fields-file bundled:<name>` to use a plugin-shipped fieldset:

| Name | What it captures |
|---|---|
| `bundled:code-audit` | summary, language, has_tests, complexity, issues[], external_deps[] |
| `bundled:skill-audit` | skill_name, has_frontmatter, description_quality, trigger_count, has_examples, issues[] |
| `bundled:security-audit` | has_secrets, uses_eval, input_validation, severity, vulnerabilities[], cwe_categories[] |
| `bundled:pr-review` | summary, category, needs_review, breaks_api, test_coverage, risks[] |

Run `mass-scout list-bundled-fieldsets --json` (or
`mass_scout_list_bundled_fieldsets`) to get the field-by-field
breakdown without opening the JSON.

### Build-fieldset shorthand

For ad-hoc fieldsets, use the shorthand parser via `build-fieldset`:

```bash
llm-externalizer mass-scout build-fieldset --name code-audit \
  --field 'summary:string(200)=One-sentence summary of this file.' \
  --field 'has_tests:bool=True if file contains test cases.' \
  --field 'complexity:enum(low,medium,high)=Estimated code complexity.' \
  --field 'issues:array_string(5)=Up to 5 quality issues.' \
  --out /tmp/code-audit.json
```

Shorthand syntax (`NAME:TYPE=DESCRIPTION`):
- `name:bool=desc` — boolean
- `name:string(120)=desc` — string with max_length
- `name:enum(a,b,c)=desc` — enum with values
- `name:array_string(8)=desc` — array of strings, max 8 items
- `name:int(1-10)=desc` — int with min..max
- `name:number(0.0-1.0)=desc` — float with min..max

For `array_object` and `array_enum`, write the JSON by hand or use
`propose-fieldset`.

### Propose-fieldset (LLM authors the fieldset)

If you don't know what fields to capture, ask the LLM to propose them:

```bash
llm-externalizer mass-scout propose-fieldset \
  --goal "find every Python module that talks to a database" \
  --samples /path/sample1.py,/path/sample2.py \
  --out /tmp/proposed.json
```

The output is a validated fieldset JSON — you can use it as-is or edit it.

## Quick start (5 steps)

```bash
# 1. Register every file under /path/to/code into a fresh SQLite db.
#    Honors gitignore by default; --no-gitignore to override.
llm-externalizer mass-scout register --db /tmp/audit.db --root /path/to/code --extensions .ts,.tsx

# 2. Cheap script-only classifier — assigns each file a bucket.
llm-externalizer mass-scout preclassify --db /tmp/audit.db

# 3. Cost preview. If it's too expensive, --budget-usd refuses to schedule.
llm-externalizer mass-scout estimate --db /tmp/audit.db \
    --fields-file bundled:code-audit --budget-usd 1.00 --live-context

# 4. Run the scout. Writes a markdown report under reports/mass_scouting/.
llm-externalizer mass-scout scout --db /tmp/audit.db \
    --fields-file bundled:code-audit \
    --job-id audit-1 --source-root /path/to/code

# 5. Search the results.
llm-externalizer mass-scout search --db /tmp/audit.db --job-id audit-1 \
    --query "react" --filter '$.complexity:=:high'
```

## Worked example: "audit-this-plugin" run

Goal: produce a per-file code review of a plugin's source.

```bash
# Register only TypeScript files.
llm-externalizer mass-scout register --db /tmp/plugin.db \
  --root /path/to/llm-externalizer-plugin/mcp-server/src \
  --extensions .ts

# Trust the bundled code-audit fieldset.
llm-externalizer mass-scout estimate --db /tmp/plugin.db \
  --fields-file bundled:code-audit \
  --live-context --budget-usd 0.50
# expect: files_eligible=~50  est_cost_usd=$0.0015  budget_allowed=true

llm-externalizer mass-scout scout --db /tmp/plugin.db \
  --fields-file bundled:code-audit \
  --job-id audit-2026-05-06 \
  --source-root /path/to/llm-externalizer-plugin/mcp-server/src
# expect: files_ok=50  files_failed=0  cost_usd=$0.0014  report=...

# Find the high-complexity files.
llm-externalizer mass-scout search --db /tmp/plugin.db \
  --job-id audit-2026-05-06 --filter '$.complexity:=:high' --json

# Audit a random sample to verify the model isn't hallucinating.
llm-externalizer mass-scout audit-sample --db /tmp/plugin.db \
  --job-id audit-2026-05-06 --n 5

# Re-scout only the files flagged 'high' with a deeper fieldset.
llm-externalizer mass-scout chain --db /tmp/plugin.db \
  --source-job audit-2026-05-06 \
  --new-job-id audit-deep \
  --new-fields-file bundled:security-audit \
  --filter '$.complexity:=:high'
```

## Cost rules-of-thumb

For `qwen/qwen-2.5-7b-instruct` (current default):
- ≈ $0.000_03 per file at ~500 bytes of body content
- Empirical 2026-05-06 calibration showed the active OpenRouter provider caps
  at **32 768 tokens** (≈ 125 KB), not the model's architectural 128K. Files
  larger than ≈ 125 KB return HTTP 400.
- Default scout cap = 40% of context = ~50 KB at the corrected `context_window`.
- Default register cap = 50% of context = ~64 KB.
- `--max-context-pct-scout 0.9` raises the scout cap to ~115 KB.
- **Use `--live-context`** on `estimate` and `scout` when you don't know
  whether your account routes to a smaller-cap endpoint — it queries
  OpenRouter for the real value and overrides KNOWN_PRICING.

For ensemble providers or larger context windows, override via
`--input-price-per-m`, `--output-price-per-m`, `--context-window`.

## Reading the report

The scout writes
`<main-repo-root>/reports/mass_scouting/<TIMESTAMP>-scout-<job-slug>.md`
with:
- Run summary (files_total/ok/failed, retries, cost, duration)
- Per-field stats (top values for enums/strings, min/max/avg for ints,
  top items for arrays)
- Skipped files (those over the scout cap)

The user typically wants this report — return ONLY the file path to
keep the orchestrator's context clean.

## Troubleshooting flowchart

```
Something went wrong with mass_scout. Where?

├── register said registered=0
│   ├── --root path empty / wrong? → verify with `ls`
│   ├── all files filtered by .gitignore? → re-run with --no-gitignore
│   └── all files > register cap? → check --extensions; raise --max-context-pct-register
│
├── preclassify shows everything as 'unknown'
│   └── files have no recognised extension and no shebang
│       → that's expected; scout still processes them with
│         --bucket sourcecode (or no bucket filter at all)
│
├── estimate shows budget_allowed=false
│   ├── too many files → narrow --bucket or filter the source tree
│   ├── files too big → lower --max-context-pct-scout
│   └── budget too low → raise --budget-usd
│
├── scout returns files_failed > 0
│   ├── HTTP 400 context length exceeded? → --live-context to find
│   │   the real cap, then lower --max-context-pct-scout to fit
│   ├── all retries exhausted? → run audit-sample on the failing
│   │   short_ids to see what the LLM returned; check
│   │   `mass_scout_skipped` table for the recorded error
│   └── circuit_tripped=true → too many consecutive failures.
│       Likely a model/schema mismatch. Try a different --model
│       or simplify the fieldset (drop array_object fields first).
│
├── scout result_json doesn't match what I expected
│   ├── audit-sample to see the raw responses
│   ├── verify the field descriptions are unambiguous
│   ├── the LLM picks weird enum values? → tighten enum to fewer values
│   └── re-run with chain on a small subset + a refined fieldset,
│       compare with diff
│
└── search returns nothing
    ├── --query is FTS5 syntax, not regex (use OR/AND/NEAR)
    ├── --filter uses '$.path:OP:value' (e.g. '$.is_async:=:true')
    └── try `get` to confirm the row exists, then refine the filter
```

## Failure modes (quick reference)

- **`HTTP 400 context length exceeded`** — file is bigger than the provider's
  context. Lower `--max-context-pct-scout` or split the file. Use
  `--live-context` to query the real cap.
- **`scout failed after N attempts`** — every retry hit the same error. The
  error message is recorded in `mass_scout_skipped` for post-mortem.
- **Smoke-test failure** — by default the scout runs the first 5 files
  sequentially. If any of them fail validation, the run aborts with the
  file path in the error so you can investigate before fanning out.
- **`OPENROUTER_API_KEY missing`** — set the env var or configure the
  plugin's `userConfig.openrouter_api_key`.
- **`circuit_tripped=true`** — the worker pool aborted after N consecutive
  failures (default 5). Investigate before retrying so you don't burn
  the budget on the same broken pipeline.

## Resume

Re-running scout with the same `--job-id` skips files that already have a
result row. Combined with the scout cap + skipped-file logging, you can
iteratively fix oversize files (split them, reduce them) and re-run until
every eligible file is scouted.

Pass `--no-resume` to force-rescout (overwrites previous results).

## Cross-job search

`search-xjob` federates across multiple `--job-ids`. Use cases:
- "Across both my v1 and v2 scout runs, find every async React file"
- "Across all my codebase scouts, find any AWS key smell"

## Diff and chain (job-to-job operations)

- **`diff --from <jobA> --to <jobB>`** — row-by-row comparison: counts of
  only_in_a, only_in_b, identical, changed (with the changed_keys per
  row). Use when re-running with a tweaked fieldset to confirm the
  change actually moved the data, not silently regressed it.
- **`chain --source-job <jobA> --new-job-id <jobB> --filter '$.x:=:value'
  --new-fields-file <path>`** — re-scout the SUBSET of jobA's results
  matching the filter, with a fresh fieldset. Use to drill deeper into
  high-value rows (e.g. files where audit flagged severity=critical)
  without re-scouting everything.

## Job introspection

- **`jobs-list`** — every job in the DB. `--json` for structured.
- **`audit-sample --job-id <id> --n <count>`** — random N result rows
  for spot-checking. Use before trusting downstream filters/reports.
- **`body-get --short-id <n>`** — print the cached file body. Useful
  when a row's result_json is surprising and you need to see what the
  LLM saw.

## Glossary

- **fieldset** — JSON description of what to extract per file (fields[]
  with name + description + type).
- **JSON Schema (compiled)** — what fieldset.ts emits at compile time;
  what the LLM is forced to obey via `response_format: json_schema`.
- **bucket** — the preclassifier's category for a file (sourcecode,
  rules_to_eval, documentation, config, log, binary, unknown). Used to
  scope `scout`/`estimate` with `--bucket`.
- **short_id** — sequential integer assigned at register time. Stable
  per-DB, much cheaper than fingerprints to print/reference.
- **fingerprint** — SHA-256 of the file body. Identity for the body
  cache (so re-registering the same content is a no-op).
- **sentinel bucket** — `chain:<jobId>` label set during a chain run on
  matching rows; restored after the run completes (success or error).
- **smoke test** — first 5 files run sequentially before the worker
  pool fans out. Aborts early if the fieldset is broken.
- **circuit breaker** — fan-out aborts after N consecutive per-file
  failures (default 5). Prevents a broken model+schema combination from
  burning the whole budget.
- **regex bypass** — `search` heuristic that runs deterministic regex
  over cached bodies for queries like "all emails", "urls in domain X",
  "all ipv4". No LLM call, no cost.

## See also

- TRDD: `design/tasks/TRDD-52547970-77f3-441c-9e8e-60be22cd2770-mass-scouting.md`
- Source: `mcp-server/src/mass_scouting/`
- Bundled fieldsets: `mcp-server/fieldsets/` — open these to learn the
  fieldset JSON dialect by example.
- CLI help: `llm-externalizer mass-scout --help`
- Calibration data: `reports/mass_scouting_calibration/`
