---
name: llm-externalizer-bench-free-pool
description: Benchmark every model in the active profile's free pool (or the bundled FREE_POOL_SEED if none is pinned) with one invocation, and optionally rewrite the pool to the models that passed. Same scoring as /llm-externalizer-benchmark but auto-fills the candidate set from the free-model list, verifies each candidate against the live OpenRouter catalog (fails fast if any configured entry is priced), and auto-discovers additional zero-cost open-beta models. Use this after switching free_only on, or to evaluate which free model best replaces a paid model.
allowed-tools:
  - Bash
argument-hint: "[--apply-free-pool PROFILE] [--pick-top-n N] [--apply-profile NAME] [--dry-run] [--security-triage] [--force]"
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

ONE Bash call, with `run_in_background: true` (always):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --bench-free-pool $ARGUMENTS
```

The CLI does everything itself: resolves the pool (active profile's `free_models`,
else the bundled `FREE_POOL_SEED`), **verifies every id against the live catalog and
refuses to run if any configured entry would cost money**, auto-discovers additional
catalog-listed $0 models, runs the same 71-function / 3-keyword scoring, writes the
report — and, with `--apply-free-pool P`, atomically rewrites profile P's
`free_models` to exactly the `:free` models that PASSED (best meanF1 first).

Zero $ by construction. You choose NOTHING; forward `$ARGUMENTS` verbatim.

## Report

The CLI's last stdout line is exactly one of:

```
[OK] <summary>. Report: <absolute path>
[FAILED] <reason>
```

Print that line **verbatim** and stop. Do not read the report; do not paraphrase it;
do not tell the user to edit `settings.yaml` — `--apply-free-pool` is the writer.

## Flags the user may ask for (pass through; do not add unprompted)

| Goal | Flag |
|---|---|
| Show what would run, no API calls | `--dry-run` |
| Maintain the pool = the free models that passed | `--apply-free-pool <profile>` |
| Also pick the top 3 free survivors into the ensemble | `--pick-top-n 3 --apply-profile <profile>` |
| Run the security_scan TRIAGE benchmark on the free pool instead | `--security-triage --force` |

Free-tier rate limits are per-account-per-day; a model that 429s after 3 retries is
recorded as ERR. That is in the report — it is not a reason to retry the command.
