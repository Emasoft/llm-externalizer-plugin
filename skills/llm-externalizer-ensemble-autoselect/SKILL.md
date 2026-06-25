---
name: llm-externalizer-ensemble-autoselect
description: |-
  Reference for rotating the OpenRouter ensemble when a model has 404'd / been
  deprecated / is misbehaving. Encodes the cost rule (input AND output both
  strictly < $1/M) and the F1-then-cost selection algorithm. Real invocation
  path is the benchmark command's CLI mode `llm-ext-benchmark --pick-top-n 3
  [--apply-profile <name>]`; this skill is loaded as background reference for
  that, not a standalone slash command.
argument-hint: "[--apply | --dry-run] [--profile <name>]"
effort: medium
user-invocable: false
---

# LLM Externalizer — Ensemble Auto-Selection

## Overview

Picks three OpenRouter models for the active `remote-ensemble` profile
**without asking the user which specific models** — you choose from the
qualifying candidates. The user has delegated this decision; do not prompt
for the picks. Selection runs the same TypeScript-AST keyword-classification
benchmark the `llm-ext-benchmark` CLI uses (`mcp-server/src/benchmark/`),
scores each qualifying model with a `meanF1` in 0..1, sorts the survivors,
and takes the top three. The full filter/ranking rules live in Resources.

**Credit-free pre-ranking.** Before any paid benchmark, candidates are
ranked by two indexes read from the public OpenRouter models endpoint
(`GET https://openrouter.ai/api/v1/models` — no API key, $0): the
*codex index score* (`benchmarks.artificial_analysis.coding_index`,
0–100) and the *design arena code categories ELO*
(`benchmarks.design_arena[arena=="models", category=="codecategories"].elo`).
Coverage is partial (~60/339 models have a codex score, ~94/339 have an
ELO); a missing index means UNKNOWN — an unscored model is **never**
dropped for lacking one. Each index is min–max normalized over models
that report it; scored models rank above unscored; cheapest is the final
tiebreak. Use `--qualifying-top-n N` to cap how many top-ranked
candidates are actually benchmarked (N paid runs instead of the whole
pool). This flag is distinct from `--pick-top-n` (which caps results
after the run); explicit `--include` baselines are never capped by it.

**Zero-cost non-`:free` models.** A model OpenRouter prices at exactly
$0 with no `:free` suffix (e.g. `openrouter/owl-alpha`, an open-beta
"free for now" model) passes the `<$1/M` cost cap and competes as a
normal ensemble candidate ranked by its indexes. The runtime free-mode
guard is now semantic: free-eligible if and only if the model id ends
`:free` OR the catalog price is exactly $0.

## Prerequisites

- An active `remote-ensemble` profile in `~/.llm-externalizer/settings.yaml`.
- `OPENROUTER_API_KEY` resolvable (a fresh benchmark hits OpenRouter).
- `llm-ext-benchmark` on PATH (ships with the plugin's mcp-server).

## Instructions

Auto-trigger when **any** of these surface: an ensemble call returns
`API error 404 (openrouter): {... "deprecated" ...}` (OpenRouter retires
models silently, so any configured model — including a current ensemble
default — can start 404ing without notice); a model returns a 4xx/5xx
**consistently** (3+ retries, same error class); or the user asks to "rotate
ensemble" / "swap broken model" / "auto-pick models" / "pick a better ensemble"
/ "the ensemble is broken". This skill is reference for the benchmark command's
`--pick-top-n` / `--apply-profile` CLI mode — there is no standalone slash
command. Do **not** auto-rotate on transient 5xx-bursts that recover on retry —
rotation is for permanent drift only.

Then run these steps:

1. Confirm the failure is **persistent** (one model, 3+ retries, same
   `400|404|410` carrying a deprecation signal). If it self-recovers, stop.
2. Pick a mode from Examples (manual / semi-auto / cache). For a 404, follow
   the detailed workflow in [selection-algorithm](references/selection-algorithm.md).
3. Run `llm-ext-benchmark --pick-top-n 3` (add `--apply-profile <name>` to
   write the picks; add `--from-cache` to reuse `benchmark-results.json`).
4. Review the picks; if fewer than 3 qualify, **surface the shortage** — do
   not silently fall back (see Error Handling).
5. Call the `reset` MCP tool (or restart Claude Code) so the running server
   reloads the new ensemble.
6. Report to the user what changed (old → new model ids + F1 / cost / latency).

## Error Handling

- **Fewer than 3 survivors**: do NOT silently fall back. Surface the shortage;
  let the user lower `--min-f1`, broaden the search, or accept fewer.
- **`meanF1 < 0.95` or `schemaCompliant === false`**: the model is rejected
  (downstream JSON parsers need schema compliance).
- **Transient 5xx**: skip rotation; only persistent 4xx with a deprecation
  signal qualifies.
- **No qualifying candidates**: report it; never auto-`--include`, never
  auto-pick a `:free` model (they log prompts upstream).

## Examples

```bash
# Manual: benchmark + print the top-3 settings.yaml block (no file change)
llm-ext-benchmark --pick-top-n 3

# Semi-auto: benchmark + apply to a named profile (atomic tmp+rename)
llm-ext-benchmark --pick-top-n 3 --apply-profile remote-ensemble

# Cache: re-pick from benchmark-results.json without new API calls
llm-ext-benchmark --from-cache --pick-top-n 3 --apply-profile remote-ensemble

# Pre-filter: benchmark only the top 20 index-ranked candidates (saves credits)
llm-ext-benchmark --qualifying-top-n 20 --pick-top-n 3 --apply-profile remote-ensemble
```

## Output

- The resolved picks, one line each: `id  meanF1  cost  latency`.
- The proposed `settings.yaml` ensemble block (`model` / `second_model` /
  `third_model`).
- If `--apply-profile` was used: the old → new model-id diff.
- One line: "Run the `reset` MCP tool or restart Claude Code to reload."
- Long benchmark reports are NOT pasted into chat — they live under
  `<main-project-dir>/reports/llm-externalizer/` (anchored on
  `$CLAUDE_PROJECT_DIR`, then cwd fallback — never derived from git;
  override with the `output_dir` arg or `$LLM_OUTPUT_DIR`).

## Resources

- [selection-algorithm](references/selection-algorithm.md) — full hard filters,
  ranking rules, the 404 workflow, anti-patterns, and the code
  single-source-of-truth table.
- Code SoT (authoritative): `mcp-server/src/benchmark/discover.ts`
  (`DEFAULT_CRITERIA`, `qualify()`) and `mcp-server/src/benchmark/pick.ts`
  (`pickTopN()`, `DEFAULT_PICK_OPTIONS`, `applyPicksToSettings()`). Edit the
  code first, then mirror the change here.
