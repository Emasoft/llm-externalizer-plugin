# Worked example: "audit-this-plugin" run

## Table of Contents

- [Pipeline run](#pipeline-run)
- [Cost rules-of-thumb](#cost-rules-of-thumb)
- [Reading the report](#reading-the-report)

## Pipeline run

Goal: produce a per-file code review of a plugin's source.

```bash
LLM_EXT="$CLAUDE_PLUGIN_ROOT/bin/llm-ext"

# Register only TypeScript files.
"$LLM_EXT" mass-scout-register --db_path /tmp/plugin.db \
  --folder_path <project-root>/scripts/llm-ext/src \
  --extensions .ts

# Script-tag each row with a bucket (sourcecode / config / documentation / …).
# Lets the later steps scope with --bucket and skip binaries for free.
"$LLM_EXT" mass-scout-preclassify --db_path /tmp/plugin.db
# expect: total=50  classified=50  by_bucket: sourcecode=50

# Cost-safety: estimate BEFORE the paid scout run (Phase 3 before Phase 4)
# — this is the built-in dry-run, and --budget_usd is a hard gate.
"$LLM_EXT" mass-scout-estimate --db_path /tmp/plugin.db \
  --fields_file bundled:code-audit \
  --live_context --budget_usd 0.50
# expect: files_eligible=~50  est_cost_usd=$0.0015  budget_allowed=true

# Only once the estimate's budget_allowed=true, run the real (paid) scout.
"$LLM_EXT" mass-scout --db_path /tmp/plugin.db \
  --fields_file bundled:code-audit \
  --job_id audit-2026-05-06 \
  --source_root <project-root>/scripts/llm-ext/src
# expect: files_ok=50  files_failed=0  cost_usd=$0.0014  report=...

# Find the high-complexity files.
"$LLM_EXT" mass-scout-search --db_path /tmp/plugin.db \
  --job_id audit-2026-05-06 --filter '$.complexity:=:high' --json

# Audit a random sample to verify the model isn't hallucinating.
"$LLM_EXT" mass-scout-audit-sample --db_path /tmp/plugin.db \
  --job_id audit-2026-05-06 --sample 5

# Re-scout only the files flagged 'high' with a deeper fieldset.
"$LLM_EXT" mass-scout-chain --db_path /tmp/plugin.db \
  --source_job audit-2026-05-06 \
  --new_job_id audit-deep \
  --new_fields_file bundled:security-audit \
  --filter '$.complexity:=:high'
```

## Cost rules-of-thumb

For `qwen/qwen-2.5-7b-instruct` (current default):
- ≈ $0.000_03 per file at ~500 bytes of body content
- Empirical 2026-05-06 calibration showed the active OpenRouter provider caps
  at **32 768 tokens** (≈ 125 KB), not the model's architectural 128K.
- Default scout cap = 40% of context; default register cap = 50%.
- Use `--live_context` on `mass-scout-estimate` (`mass-scout` itself also
  accepts `--live_context`) when you don't know whether your account routes
  to a smaller-cap endpoint.

## Reading the report

The scout writes
`<main-project-dir>/reports/mass_scouting/<TIMESTAMP>-scout-<job-slug>.md`
(anchored on `$CLAUDE_PROJECT_DIR`, cwd fallback — never derived from git)
with:
- Run summary (files_total/ok/failed, retries, cost, duration)
- Per-field stats (top values for enums/strings, min/max/avg for ints,
  top items for arrays)
- Skipped files (those over the scout cap)
