---
trdd-id: 6e859d3c-3116-4169-90da-a24c1b747e96
title: Part-D script-bug remediation — honor each helper's own contract, with TDD
status: completed
created: 2026-05-25T09:53:56+0200
updated: 2026-05-25T10:02:36+0200
---

# TRDD-6e859d3c — Part-D script-bug remediation (honor-contract + TDD)

**Filename:** `design/tasks/TRDD-20260525_095356+0200-6e859d3c-script-bug-remediation.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)
**Source spec:** [[TRDD-828238b5]] Part D (the deep-audit bug backlog) + Part F (test gaps).

## Why now

`/go-on-yourself` (2026-05-25). A1–A5 of the auto-* roadmap shipped; A6/A7 are
blocked on the risky index.ts split. The next highest-value, lowest-risk
increment is Part D: **six verified correctness defects in LIVE Python helpers**
(setup wizard, statusline, fixer pipeline). Verified on real ground before
planning: D1's `_yaml_dquote` rejects `\n`/`\r` at the control-char guard BEFORE
the `.replace("\n","\\n")` (dead code + false docstring), and
`_validate_profile_name`'s regex accepts YAML-reserved tokens (`null`/`yes`/…)
emitted UNQUOTED despite the comment promising to reject them. The audit is
reliable; each agent re-verifies its own item.

## Governing principle (from 828238b5 Part D)

Honor each function's OWN documented contract:
- Where a docstring PROMISES "never raise" / "return an error dict" (batch-loop
  resilience), making it actually not-raise IS correct — NOT a fail-fast
  violation.
- Where there is NO such contract, prefer fail-fast (let it raise / exit).
- Never relax a security or validation guard. Minimal fixes, no bloat, reuse.

## TDD

Every fix lands with a pytest test that FAILS before the fix and PASSES after,
in the existing harness (`tests/`, `uv run pytest`, `testpaths=["tests"]`).
Separate test file per script so the parallel agents never collide; D3 and D6
EXTEND their existing test files (`test_benchmark_models.py`, `test_statusline.py`).

## Work items (one parallel spark agent per file)

| ID | File | Defect (verify first) | Contract-honoring fix | Test file |
|----|------|-----------------------|------------------------|-----------|
| D1 | `scripts/setup/build-snippet.py` | (a) docstring says newlines escaped, code REJECTS them (dead `.replace("\n"/"\r")`); (b) `SystemExit(str)` exits 1 but docstring/usage may promise 2 for safety-guard violations; (c) `_validate_profile_name` accepts YAML-reserved tokens emitted unquoted, though comment promises rejection; (d) argparse exit-code doc mismatch | Make docstring tell the truth (control chars incl `\n`/`\r` are REJECTED) + drop the two dead replaces (keep `\t`); reject YAML-reserved tokens (null/true/false/yes/no/on/off/~, case-insensitive) in `_validate_profile_name` to honor the comment; align documented exit codes with reality (or `raise SystemExit(2)` where a 2 is promised) | `tests/test_build_snippet.py` (new) |
| D2 | `scripts/setup/_bench_helpers.py` | `_avg_test_score`/`rank_models`/`render_markdown` direct-index `record["tests"]`/`r["perf"]` → KeyError crashes the whole rank/render despite `_is_viable` using `.get(...,{})` (batch-resilience contract) | Use `.get(...)` with safe defaults to honor the resilience contract `_is_viable` already follows | `tests/test_bench_helpers.py` (new) |
| D3 | `scripts/setup/benchmark-models.py` | `measure_throughput` lets `call_chat` exceptions escape (docstring: return error dict); `benchmark_one_model` missing the try/except guard it uses for reliability tests; `run_vmlx_bench` `float()/int()` can raise ValueError vs "never raise"; `"error" in resp` without `isinstance dict` | Wrap per the "never raise / return error dict" docstring; guard the `float()/int()` parse; `isinstance(resp, dict)` before `in` | `tests/test_benchmark_models.py` (extend) |
| D4 | `scripts/setup/detect-runners.py` | `_safe_model_names` does `(payload or {}).get(...)` → AttributeError when JSON is a list; `_vllm_import_probe` misses some "installed but broken" failures | Guard non-dict payloads (isinstance check); broaden the vLLM import-probe failure detection | `tests/test_detect_runners.py` (new) |
| D5 | `scripts/fix_found_bugs_helper.py` | `_find_report_files` `--skip-if-fixer-exists` matches only `.fixer.` siblings, not the canonical `-fixer-` pattern `_is_sidecar` recognizes → skip filter disabled, fixed reports re-aggregated. CONFIRM the real fixer-sidecar naming via `validate_fixer_summary.py` / `join_fixer_reports.py` first | Align the skip-filter glob/regex with the canonical `_is_sidecar` naming (single source of truth) | `tests/test_fix_found_bugs_helper.py` (new) |
| D6 | `scripts/statusline/*.py` | `fetch_usage_from_api` (~305) and `fetch_openrouter_budget` (~346) use bare `except Exception:` → silently swallow all errors, masking diagnosis | Keep fail-soft VISUAL behavior but LOG the error cause (no silent swallow); narrow the except where reasonable | `tests/test_statusline.py` (extend) |

## Pre-completion verification (orchestrator)

After all six agents report: `uv run pytest -q` (all green), `cd mcp-server && npm test`
(the 883 TS tests stay green — D-fixes are Python-only, must not regress), `npm run build`
clean. Then ONE commit per logical item (or a single batch commit with a detailed
changelog listing D1–D6) so any item is independently revertable. Update any
docstring/usage text the fixes touch; update README/help only if a user-facing
contract changed (none expected — these are internal helpers).

## Outcome — DONE (2026-05-25)

All six items fixed via parallel spark agents (each verified its own defect on
real ground, wrote a failing test first, applied the minimal contract-honoring
fix). Commits: f64b342 (D1), d514220 (D2), dc56d71 (D3), 4678a8a (D4), 52563d0
(D5), 5512072 (D6) — one per item for independent revert.

- Python suite: 81 → **126 tests, all green** (+45 new). `uv run ruff check
  scripts/ tests/` clean (the project's E/F/W/I lint gate). TS untouched
  (only `.py` changed) so the 883 vitest gate is unaffected.
- Pyright "could not resolve pytest / unused-stub-arg" diagnostics are
  venv-resolution noise / pre-existing line-shifted NITs — NOT flagged by ruff.
- D1 chose exit-2 (print+SystemExit(2)) over downgrading the docstring, to
  honor the documented exit-2 safety-guard contract and stay distinct from the
  exit-1 arg guards + match argparse's own exit-2.
- D5: `-fixer-` IS canonical (already in `SIDECAR_MARKERS`); the bug was two
  sources of truth (skip-filter hardcoded `.fixer.` only). Unified via the new
  `FIXER_MARKERS` subset.
- Docs updated for the changed contracts: `commands/llm-externalizer-fix-found-bugs.md`
  (skip-filter now both fixer shapes), `commands/llm-externalizer-scan-and-fix-serially.md`
  (×2 fixer-tag refs), `agents/llm-externalizer-setup-agent.md` (reserved-name
  rejection + exit codes). README/CHANGELOG need no change (build-snippet is
  referenced only generically; CHANGELOG is git-cliff-generated).

## Out of scope (tracked elsewhere)

- A6/A7 ([[TRDD-828238b5]]) — focused follow-up.
- Cluster B2–B5 ([[TRDD-828238b5]] Part B) — riskier; next increment after D.
- Part E dead-code removal — RULE 0 (needs explicit user approval); not touched here.
