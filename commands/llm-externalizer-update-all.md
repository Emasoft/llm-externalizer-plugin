---
name: llm-externalizer-update-all
description: The WHOLE model refresh in one command — discover the live OpenRouter catalog, requirement-gate every tool, run every benchmark, rank, and write the winners (ensemble + per-tool models + the free_models pool) to settings.yaml. Hard spend cap; defaults to a provably $0 free-model refresh. Trigger with "update all the models", "refresh everything", "full model update", "update the model config", "search for free models", "rescan and apply", "update models and benchmarks". This ONE command IS the entire pipeline — route here instead of chaining the individual benchmark commands.
allowed-tools:
  - Bash
argument-hint: "[--free | --paid | --both] [--budget-usd X] [--dry-run]"
effort: low
---

Run the command below. Print its final line. Nothing else.

## Run

ONE Bash call, with `run_in_background: true` (always — a full refresh takes 10-40 min):

```bash
"${CLAUDE_PLUGIN_ROOT}/bin/llm-ext-benchmark" --update-all $ARGUMENTS
```

Forward `$ARGUMENTS` verbatim. **Add no flags of your own.**

The CLI does the entire pipeline itself: prerequisite checks, catalog discovery, the
per-tool requirements gate, the free-models search, every benchmark, the ranking, the
atomic `settings.yaml` writes (ensemble + `tool_models.*` + `free_models`), the spend
accounting, and the report. You choose nothing.

## Report

The CLI's last stdout line is exactly one of:

```
[OK] <summary>. Report: <absolute path>
[FAILED] <reason>
```

Print that line **verbatim** and stop. Do not read the report. Do not summarize,
re-word, or append next steps — the line already carries the counts, the spend, and the
path, and the exit code already carries success/failure.

## Cost — the CLI enforces this, you do not

| Invocation | Spends |
|---|---|
| `--update-all` (no flags) | **$0.** Default. Free/zero-cost models only, enforced at the HTTP chokepoint. |
| `--update-all --dry-run` | **$0.** Prints the plan + a worst-case estimate. |
| `--update-all --paid` | Real money, capped at `--budget-usd` (default **$2.00**). |
| `--update-all --both` | Free phase, then paid phase, on one shared cap. |

If a paid run's **worst-case** pre-flight estimate exceeds the cap, the CLI **aborts
before sending a single call** ($0 spent) and its `[FAILED]` line names the exact
`--budget-usd` that would authorize it. The estimate assumes every call emits its full
`max_tokens`, so it is deliberately pessimistic — a full paid sweep at the default
15-candidate cap typically estimates well above what it actually spends.

**Print that line and stop.** Do NOT re-run with a higher budget on your own
initiative — raising a spend cap is the user's decision, never yours.

## Never

- Never re-run a `[FAILED]` budget abort with a bigger `--budget-usd` unless the user
  explicitly asks. The abort is the safety feature working.
- Never add `--paid` or `--both` unless the user asked to spend money. The default is $0.
- Never edit `settings.yaml` by hand — the CLI is the only writer.
- Never chain the individual benchmark commands to emulate this; that re-sends the whole
  transcript per turn and spends per call. This command exists to replace that.

## What it writes

The active profile's `model` / `second_model` / `third_model` (the ensemble), each
`tool_models.<tool>` winner, and the `free_models` pool. Atomic (tmp + rename); every
other key and profile is preserved. Run `reset` afterwards to reload.

Full flag list: `llm-ext-benchmark --help`.
