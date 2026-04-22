---
name: llm-externalizer-benchmark
description: Benchmark OpenRouter programming-category models against a TypeScript classification task. Filters by cost + capability, scores each candidate against 71 fixture functions + 3 literal keywords, writes a markdown comparison report. Use this to pick the cheapest model that still passes the real workload.
allowed-tools:
  - Bash
argument-hint: "[--include MODEL_ID]... [--dry-run] [--report PATH] [--reasoning low|medium|high] [--seed N]"
effort: medium
---

Runs the `llm-ext-benchmark` CLI bundled with the plugin. Forwards `$ARGUMENTS` verbatim.

## What the benchmark does

1. Queries `https://openrouter.ai/api/v1/models?category=programming`.
2. Filters to models with context ≥ 128K, max output ≥ 64K, structured outputs + reasoning supported, input ≤ $1.5/M tokens, output ≤ $2.0/M tokens, excluding `:free` tier.
3. For each qualifying candidate (plus any `--include MODEL_ID` baselines, which bypass the cost filter), sends the 5 fixture TypeScript files (71 top-level functions) and asks the model — under a strict JSON schema — to list every function whose body contains each of three literal substrings: `JSON.parse(`, `new URLSearchParams`, `performance.now()`.
4. Compares the returned arrays against the ground truth (derived at runtime from the fixtures via the TypeScript compiler API). PASS = all 3 arrays exact match; partial-credit F1 is reported for failures.
5. Writes a markdown report to `$MAIN_ROOT/reports/benchmark/<ts±tz>-model-comparison.md`.

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

## Error handling

| Error | Resolution |
|-------|------------|
| CLI binary not bundled | Abort `[FAILED] — CLI not found at $CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark`. The plugin build is incomplete. |
| Auth missing | Abort `[FAILED] — OPENROUTER_API_KEY not set`. Tell user to export it or set the plugin userConfig. |
| CLI exits non-zero | Surface the last stderr line in the `[FAILED]` message. Do NOT retry. |
