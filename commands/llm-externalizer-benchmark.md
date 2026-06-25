---
name: llm-externalizer-benchmark
description: Benchmark OpenRouter programming-category models against a TypeScript classification task. Filters by cost + capability, scores each candidate against 71 fixture functions + 3 literal keywords, writes a markdown comparison report. Use this to pick the cheapest model that still passes the real workload.
allowed-tools:
  - Bash
argument-hint: "[--include MODEL_ID]... [--dry-run] [--report PATH] [--reasoning low|medium|high] [--seed N] [--qualifying-top-n N]"
effort: medium
---

Runs the `llm-ext-benchmark` CLI bundled with the plugin. Forwards `$ARGUMENTS` verbatim.

## What the benchmark does

1. Queries `https://openrouter.ai/api/v1/models?category=programming`.
2. Filters to models with context ≥ 128K, max output ≥ 64K, structured outputs + reasoning supported, and both input AND output priced **strictly under $1/M** (`< $1.00`, so $1.00 itself is rejected), excluding the `:free` tier. Models priced at exactly $0 without a `:free` suffix (e.g. `openrouter/owl-alpha`) are valid candidates — $0 passes the cost cap.
3. Pre-ranks candidates using two credit-free quality indexes read from the same public endpoint (no API key, $0): the **codex index score** (`benchmarks.artificial_analysis.coding_index`, 0–100) and the **design arena code-categories ELO** (the `benchmarks.design_arena[]` entry where `arena=="models"` and `category=="codecategories"`, its `.elo`). Scores are min–max normalized and composited; scored models rank above unscored; cheapest breaks ties. A missing index = UNKNOWN, never a disqualifier. If `--qualifying-top-n N` is set, only the top N pre-ranked candidates proceed to paid runs — use this to cap spend without excluding explicit `--include` baselines, which are never capped.
4. For each qualifying candidate (plus any `--include MODEL_ID` baselines, which bypass the cost filter), sends the 5 fixture TypeScript files (71 top-level functions) and asks the model — under a strict JSON schema — to list every function whose body contains each of three literal substrings: `JSON.parse(`, `new URLSearchParams`, `performance.now()`.
5. Compares the returned arrays against the ground truth (derived at runtime from the fixtures via the TypeScript compiler API). PASS = all 3 arrays exact match; partial-credit F1 is reported for failures.
6. Writes a markdown report to `$MAIN_ROOT/reports/benchmark/<ts±tz>-model-comparison.md`.

No agents. No MCP tools. No retry loops beyond what the CLI itself implements. Deterministic (`temperature=0`, optional `--seed`).

## Step 1 — Check prerequisites

Using `Bash`:

1. `test -x "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark"` — abort with `[FAILED] llm-externalizer-benchmark — CLI not found at $CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark` if missing.
2. Skip the dry-run auth check when `$ARGUMENTS` contains `--dry-run`. Otherwise verify auth:
   ```bash
   if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY:-}" ]; then
       echo "[FAILED] llm-externalizer-benchmark — OPENROUTER_API_KEY not set (or set the plugin option 'openrouter_api_key' via /plugin configure llm-externalizer)"
       exit 1
   fi
   ```

## Step 2 — Run the benchmark

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" $ARGUMENTS
```

The CLI streams progress to stderr as `[benchmark] ...` lines (one per model), then prints the final report path and pass count. Propagate the exit code.

Typical cost for a default sweep is well under $0.10 (≈$0.005–$0.02 per candidate depending on reasoning token usage). `--dry-run` makes zero API calls.

## Step 3 — Return

The CLI's last stderr line already shows the report path (`[benchmark] Report: <absolute path>`) and the pass count (`[benchmark] N/M models passed`). Surface both to the user — the report path is the only artifact the user needs.

Do NOT `Read` the report. Its content is the user's output, not the orchestrator's.

## Constraints

- Never bypass the cost filter with ad-hoc edits — if the user wants a non-qualifying model evaluated, they pass `--include MODEL_ID` (baseline slot, clearly tagged in the output).
- Never summarize or reformat the report. Only the path flows back.
- The CLI is a single-pass, non-agentic runner. Do NOT wrap it in a retry loop or re-score its output.

## Examples

| Goal | Invocation |
|---|---|
| Show the qualifying roster without spending anything | `/llm-externalizer:llm-externalizer-benchmark --dry-run` |
| Full sweep (candidates only) | `/llm-externalizer:llm-externalizer-benchmark` |
| Sweep plus current production ensemble as baselines | `/llm-externalizer:llm-externalizer-benchmark --include google/gemini-3-flash-preview --include x-ai/grok-4.1-fast` |
| Force reasoning-heavy runs for sensitivity testing | `/llm-externalizer:llm-externalizer-benchmark --reasoning high` |
| Cap paid runs to the top 5 pre-ranked candidates | `/llm-externalizer:llm-externalizer-benchmark --qualifying-top-n 5` |

## Three-surface compliance: by-design no MCP tool (GAP-2)

The benchmark is **CLI + slash command**, with **no MCP tool** — by
design. Rationale documented in TRDD-f1510055 §"Why no MCP tool":

- A sweep takes 10–30 minutes (15 models × ~60s each for the keyword
  task, more for `--security-triage`). Every other MCP tool the
  plugin exposes completes in seconds to a few minutes.
- Exposing it as a tool would let any orchestrator agent trigger a
  half-hour blocking operation on the user's account.
- It writes a cache the WHOLE plugin reads (`~/.llm-externalizer/benchmark-results.json`),
  not a per-call artifact — closer to a build step than a tool call.

The MCP-equivalent fourth surface is the **auto-trigger** wired into
the MCP server's startup + settings-reload paths (see
`/llm-externalizer:llm-externalizer-bench-free-pool` and TRDD-f1510055).
When `free_only` flips ON and the cache lacks `:free` entries, the
server spawns a detached bench process. This delivers the
"capability available without leaving the MCP layer" property
without the agent-triggered half-hour-block hazard.

`pickTopN` + `--apply-profile` (the GAP-3 "ensemble-autoselect"
capability) is exposed as a CLI mode of this same binary
(`--pick-top-n N --apply-profile <name>`) rather than a separate
MCP tool — its core (`benchmark/pick.ts`) reads the same cache the
benchmark writes, so a "rotate" call without a prior benchmark would
be a no-op or stale-pick footgun.

## Error handling

| Error | Resolution |
|-------|------------|
| CLI binary not bundled | Abort `[FAILED] — CLI not found at $CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark`. The plugin build is incomplete. |
| Auth missing | Abort `[FAILED] — OPENROUTER_API_KEY not set`. Tell user to export it or set the plugin userConfig. |
| CLI exits non-zero | Surface the last stderr line in the `[FAILED]` message. Do NOT retry. |
