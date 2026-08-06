# Mass-scouting troubleshooting

## Table of Contents

- [Symptom flowchart](#symptom-flowchart)
- [Failure modes](#failure-modes)
- [Resume](#resume)

## Symptom flowchart

```
Something went wrong with mass-scout. Where?

├── mass-scout-register said registered=0
│   ├── --folder_path empty / wrong? → verify with `ls`
│   ├── all files filtered by .gitignore? → re-run with --no_gitignore
│   └── all files > register cap? → check --extensions; raise --max_context_pct_register
│
├── mass-scout-preclassify shows everything as 'unknown'
│   └── files have no recognised extension and no shebang
│       → that's expected; scout still processes them with
│         --bucket sourcecode (or no bucket filter at all)
│
├── mass-scout-estimate shows budget_allowed=false
│   ├── too many files → narrow --bucket or filter the source tree
│   ├── files too big → lower --max_context_pct_scout
│   └── budget too low → raise --budget_usd
│
├── mass-scout returns files_failed > 0
│   ├── HTTP 400 context length exceeded? → --live_context to find
│   │   the real cap, then lower --max_context_pct_scout to fit
│   ├── all retries exhausted? → run mass-scout-audit-sample on the
│   │   failing short_ids to see what the LLM returned; check
│   │   `mass_scout_skipped` table for the recorded error
│   └── circuit_tripped=true → too many consecutive failures.
│       Likely a model/schema mismatch. Try a different --model
│       or simplify the fieldset (drop array_object fields first).
│
├── scout result_json doesn't match what I expected
│   ├── mass-scout-audit-sample to see the raw responses
│   ├── verify the field descriptions are unambiguous
│   ├── the LLM picks weird enum values? → tighten enum to fewer values
│   └── re-run with mass-scout-chain on a small subset + a refined
│       fieldset, compare with mass-scout-diff
│
└── mass-scout-search returns nothing
    ├── --query is FTS5 syntax, not regex (use OR/AND/NEAR)
    ├── --filter uses '$.path:OP:value' (e.g. '$.is_async:=:true')
    └── try `mass-scout-get` to confirm the row exists, then refine the filter
```

## Failure modes

- **`HTTP 400 context length exceeded`** — file is bigger than the provider's
  context. Lower `--max_context_pct_scout` or split the file. Use
  `--live_context` to query the real cap.
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

Re-running `mass-scout` with the same `--job_id` skips files that already
have a result row. Combined with the scout cap + skipped-file logging, you
can iteratively fix oversize files (split them, reduce them) and re-run
until every eligible file is scouted.

Pass `--no_resume` to force-rescout (overwrites previous results).
