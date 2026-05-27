---
name: llm-externalizer-bench-free-pool
description: Benchmark every model in the active profile's free pool (or the bundled FREE_POOL_SEED if none is pinned) with one invocation. Same scoring as /llm-externalizer-benchmark but auto-fills the candidate set from the free-model list and refuses to run if any entry is not a ':free' model. Use this after switching free_only on, or to evaluate which free model best replaces a paid model.
allowed-tools:
  - Bash
argument-hint: "[--dry-run] [--report PATH] [--security-triage] [--force]"
effort: medium
---

Runs the bundled `llm-ext-benchmark` CLI with `--bench-free-pool` so the candidate set is auto-filled from the active profile's `free_models` list. Forwards any extra `$ARGUMENTS` verbatim.

## What this command does

1. Loads the active profile via the plugin's settings.yaml resolver.
2. If the profile pins `free_models`, uses that list; otherwise falls back to the bundled `FREE_POOL_SEED` constant (the 15 seed ids the plugin ships — `poolside/laguna-m.1:free`, `deepseek/deepseek-v4-flash:free`, the two `google/gemma-4-*:free` variants, the two `nvidia/nemotron-3-*:free` variants, `minimax/minimax-m2.5:free`, `qwen/qwen3-next-80b-a3b-instruct:free`, `openai/gpt-oss-{120b,20b}:free`, `qwen/qwen3-coder:free`, `z-ai/glm-4.5-air:free`, `meta-llama/llama-3.3-70b-instruct:free`, `nousresearch/hermes-3-llama-3.1-405b:free`).
3. Refuses to run if any entry is missing the `:free` suffix — the flag is a cost-safety chokepoint, not a generic auto-include.
4. Hands the resolved ids to the existing benchmark pipeline (`--include` slots in keyword mode, `--model` slots in `--security-triage` mode).
5. Each model receives the same scoring as `/llm-externalizer-benchmark`: 71 fixture functions × 3 literal keywords, F1 against ground truth, strict JSON schema enforced.
6. Writes the markdown report to `$MAIN_ROOT/reports/benchmark/<ts±tz>-model-comparison.md` (or `reports/security-triage-benchmark/` for triage mode).

Zero $ by construction — the runner's airtight free-only chokepoint (TRDD-97ef8b63) rejects any non-`:free` model that somehow leaks through. Free-tier rate limits do apply; the runner retries 429s up to 3× with exponential backoff (cap 60s).

## Step 1 — Check prerequisites

Using `Bash`:

1. `test -x "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark"` — abort with `[FAILED] llm-externalizer-bench-free-pool — CLI not found at $CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark` if missing.
2. Skip the auth check when `$ARGUMENTS` contains `--dry-run`. Otherwise verify auth:
   ```bash
   if [ -z "${OPENROUTER_API_KEY:-}" ] && [ -z "${CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY:-}" ]; then
       echo "[FAILED] llm-externalizer-bench-free-pool — OPENROUTER_API_KEY not set (or set the plugin option 'openrouter_api_key' via /plugin configure llm-externalizer)"
       exit 1
   fi
   ```

## Step 2 — Run the sweep

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --bench-free-pool $ARGUMENTS
```

The CLI logs the resolved pool source (active profile vs `FREE_POOL_SEED`) on stderr before the sweep starts, then streams `[benchmark] ...` progress lines, then prints the final report path. Propagate the exit code.

## Step 3 — Return

The CLI's last stderr line shows the report path (`[benchmark] Report: <absolute path>`) and the pass count (`[benchmark] N/M models passed`). Surface both to the user — the report path is the only artifact the user needs.

Do NOT `Read` the report. Its content is the user's output, not the orchestrator's.

## Constraints

- Cost-safety: the pool MUST contain only `:free`-suffixed ids. The CLI throws if not.
- Composes with `--security-triage`: when both are set, the pool feeds `--model` slots instead of `--include`, and the security_scan TRIAGE benchmark runs.
- Free-tier rate limits are per-account-per-day. Models that 429 even after 3 retries are recorded as ERR — re-run later, or split the sweep across two days.

## Examples

| Goal | Invocation |
|---|---|
| Show which models would be benchmarked (no API calls) | `/llm-externalizer:llm-externalizer-bench-free-pool --dry-run` |
| Score every free seed against the keyword task | `/llm-externalizer:llm-externalizer-bench-free-pool` |
| Pick the top 3 free survivors and apply to active profile | `/llm-externalizer:llm-externalizer-bench-free-pool --pick-top-n 3 --apply-profile remote-free-ensemble --min-f1 0.5` |
| Run the security_scan TRIAGE benchmark on every free model | `/llm-externalizer:llm-externalizer-bench-free-pool --security-triage --force` |

## Error handling

| Error | Resolution |
|-------|------------|
| CLI binary not bundled | Abort `[FAILED] — CLI not found at $CLAUDE_PLUGIN_ROOT/bin/llm-ext-benchmark`. The plugin build is incomplete. |
| Auth missing | Abort `[FAILED] — OPENROUTER_API_KEY not set`. Tell user to export it or set the plugin userConfig. |
| Pool contains a non-`:free` id | Abort `[FAILED] — pool contains non-':free' ids`. Fix the active profile's `free_models` list. |
| Every model 429s after retries | Re-run later; free-tier rate limits are per-day. |
| CLI exits non-zero | Surface the last stderr line in the `[FAILED]` message. Do NOT retry. |
