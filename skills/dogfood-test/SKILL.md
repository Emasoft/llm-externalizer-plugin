---
name: dogfood-test
description: Internal maintainer dogfood harness for the llm-externalizer plugin — exercises every surface (CLI verbs, benchmark, all slash commands, all skills) with a zero-spend offline sweep plus an opt-in free-pool live smoke. NOT user-invocable; run via tests/dogfood/dogfood_test.py. Use when validating a release or after touching any tool, command, or skill.
user-invocable: false
---

# dogfood-test

Permanent self-test that drives every surface of the llm-externalizer plugin and
reports a pass/fail table. It is a **maintainer harness**, not an end-user
feature — there is no slash command and `user-invocable: false`.

## How to run

```bash
# Default — zero OpenRouter spend (offline / catalog-only checks).
uv run tests/dogfood/dogfood_test.py

# Opt-in live smoke — still $0 (routes chat + code_task through the validated
# free pool; asserts the model used ends in ':free'). Heavily rate-limited.
DOGFOOD_LIVE=1 uv run tests/dogfood/dogfood_test.py
```

Exit code is `0` when every row is PASS/SKIP, non-zero on any FAIL. A full
markdown report is written under `<main-repo-root>/reports/dogfood/`.

## What it checks

| Phase | Surface | Cost |
|-------|---------|------|
| Build | `npm run build` (dist current) | $0 |
| Health | `bin/llm-ext discover` (auth + profile + balance probe, no LLM) | $0 |
| CLI help | `--help` for every verb in `bin/llm-ext`'s TOOL_CATALOG + top-level + benchmark | $0 |
| Benchmark | `llm-ext-benchmark --dry-run` and `--bench-free-pool --dry-run` | $0 |
| Read-only tools | `get-settings`, `or-model-info-json`, `discover-new-models` (public catalog) | $0 |
| Slash commands | structural audit of every `commands/*.md` (frontmatter + wrapped-tool resolves) | $0 |
| Skills | structural audit of every `skills/*/SKILL.md` (frontmatter validity) | $0 |
| Live smoke | `chat` + `code_task` on a tiny fixture, free-pool only — **opt-in** (`DOGFOOD_LIVE=1`) | $0 |

## Cost-safety contract

Default runs never issue a billable completion: only the public model catalog,
the `discover` balance probe, and `--help` / `--dry-run` are exercised. The live
smoke is opt-in and asserts a `:free` model, so it is `$0` too. The harness must
never set a paid model or write to `~/.claude` / `~/.llm-externalizer`.

## Reading the table

Heavy-bordered header, light rows; the 6-char status column is `PASS`, `FAIL`,
`WARN`, or `SKIP`. Slow / live rows are marked 🐌. On any FAIL the row names the
surface, the verb/file, and the symptom — triage real plugin defects from
environmental causes (free-tier rate-limit ≠ a bug) before fixing.
