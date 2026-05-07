# Worked example: "audit-this-plugin" run

Goal: produce a per-file code review of a plugin's source.

```bash
# Register only TypeScript files.
llm-externalizer mass-scout register --db /tmp/plugin.db \
  --root <project-root>/mcp-server/src \
  --extensions .ts

# Trust the bundled code-audit fieldset.
llm-externalizer mass-scout estimate --db /tmp/plugin.db \
  --fields-file bundled:code-audit \
  --live-context --budget-usd 0.50
# expect: files_eligible=~50  est_cost_usd=$0.0015  budget_allowed=true

llm-externalizer mass-scout scout --db /tmp/plugin.db \
  --fields-file bundled:code-audit \
  --job-id audit-2026-05-06 \
  --source-root <project-root>/mcp-server/src
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
  at **32 768 tokens** (≈ 125 KB), not the model's architectural 128K.
- Default scout cap = 40% of context; default register cap = 50%.
- Use `--live-context` on `estimate` and `scout` when you don't know whether
  your account routes to a smaller-cap endpoint.

## Reading the report

The scout writes
`<main-repo-root>/reports/mass_scouting/<TIMESTAMP>-scout-<job-slug>.md`
with:
- Run summary (files_total/ok/failed, retries, cost, duration)
- Per-field stats (top values for enums/strings, min/max/avg for ints,
  top items for arrays)
- Skipped files (those over the scout cap)
