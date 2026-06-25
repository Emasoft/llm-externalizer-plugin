---
name: llm-externalizer-bench-free-pool
description: Benchmark every model in the active profile's free pool (or the bundled FREE_POOL_SEED if none is pinned) with one invocation. Same scoring as /llm-externalizer-benchmark but auto-fills the candidate set from the free-model list, verifies each candidate against the live OpenRouter catalog (fails fast if any configured entry is priced), and auto-discovers additional zero-cost open-beta models the catalog lists. Use this after switching free_only on, or to evaluate which free model best replaces a paid model.
allowed-tools:
  - Bash
argument-hint: "[--dry-run] [--report PATH] [--security-triage] [--force]"
effort: medium
---

Runs the bundled `llm-ext-benchmark` CLI with `--bench-free-pool` so the candidate set is auto-filled from the active profile's `free_models` list. Forwards any extra `$ARGUMENTS` verbatim.

## What this command does

1. Loads the active profile via the plugin's settings.yaml resolver.
2. If the profile pins `free_models`, uses that list; otherwise falls back to the bundled `FREE_POOL_SEED` constant (the 15 seed ids the plugin ships — `poolside/laguna-m.1:free`, `deepseek/deepseek-v4-flash:free`, the two `google/gemma-4-*:free` variants, the two `nvidia/nemotron-3-*:free` variants, `minimax/minimax-m2.5:free`, `qwen/qwen3-next-80b-a3b-instruct:free`, `openai/gpt-oss-{120b,20b}:free`, `qwen/qwen3-coder:free`, `z-ai/glm-4.5-air:free`, `meta-llama/llama-3.3-70b-instruct:free`, `nousresearch/hermes-3-llama-3.1-405b:free`).
3. Resolves the pool against the live OpenRouter catalog (public endpoint, no API key required, zero cost). A configured non-`:free` id is admitted only when the catalog prices it at exactly $0; if it is priced or absent from the catalog the command **fails fast before any API run**. `:free` ids are admitted as-is. Then auto-discovers every additional catalog-listed zero-cost model — including open-beta "free for now" models without a `:free` suffix (e.g. `openrouter/owl-alpha`) — that meets the structural bar (structured output, reasoning, context, output length), ranked by the free quality indexes (codex `coding_index` + design-arena code ELO) and capped at `--qualifying-top-n`.
4. Hands the resolved ids to the existing benchmark pipeline (`--include` slots in keyword mode, `--model` slots in `--security-triage` mode).
5. Each model receives the same scoring as `/llm-externalizer-benchmark`: 71 fixture functions × 3 literal keywords, F1 against ground truth, strict JSON schema enforced.
6. Writes the markdown report to `$MAIN_ROOT/reports/benchmark/<ts±tz>-model-comparison.md` (or `reports/security-triage-benchmark/` for triage mode).

Zero $ by construction — the catalog price-verification step (step 3) is the primary guard when `--bench-free-pool` runs outside a `free_only` profile, since the runtime free-mode guard only fires under `free_only`. The runtime guard itself is now semantic: a model is free-eligible iff its id ends `:free` OR the live catalog prices it at exactly $0. Free-tier rate limits do apply; the runner retries 429s up to 3× with exponential backoff (cap 60s).

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

- Cost-safety: configured non-`:free` ids are admitted only when the live catalog confirms a price of exactly $0; the CLI fails fast before any run if an entry is priced or absent from the catalog. `:free` ids are always admitted as-is.
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
| Configured non-`:free` id is priced or absent from catalog | Abort `[FAILED] — pool contains priced or unlisted id`. Replace with a `:free`-suffixed id or one the catalog confirms at $0; the command will not run if any entry would cost money. |
| Every model 429s after retries | Re-run later; free-tier rate limits are per-day. |
| CLI exits non-zero | Surface the last stderr line in the `[FAILED]` message. Do NOT retry. |
