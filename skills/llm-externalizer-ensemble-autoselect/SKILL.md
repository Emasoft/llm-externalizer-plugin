---
name: llm-externalizer-ensemble-autoselect
description: |-
  Use when an ensemble model has 404'd / been deprecated / is misbehaving,
  or the user asks to "rotate the ensemble", "swap a broken model", "pick a
  better ensemble", "auto-pick models", or LLM Externalizer request errors
  show consistent failures on one configured model. Encodes the cost rule
  (input AND output both strictly < $1/M) and the F1-then-cost selection
  algorithm. Trigger with /llm-externalizer-ensemble-autoselect or
  "rotate the ensemble".
argument-hint: "[--apply | --dry-run] [--profile <name>]"
effort: medium
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

## Prerequisites

- An active `remote-ensemble` profile in `~/.llm-externalizer/settings.yaml`.
- `OPENROUTER_API_KEY` resolvable (a fresh benchmark hits OpenRouter).
- `llm-ext-benchmark` on PATH (ships with the plugin's mcp-server).

## Instructions

Auto-trigger when **any** of these surface: an ensemble call returns
`API error 404 (openrouter): {... "deprecated" ...}` (e.g. `x-ai/grok-4.1-fast`,
2026-05-23 — OpenRouter retires models silently); a model returns a 4xx/5xx
**consistently** (3+ retries, same error class); the user types "rotate
ensemble" / "swap broken model" / "auto-pick models" / "pick a better ensemble"
/ "the ensemble is broken"; or the user invokes
`/llm-externalizer-ensemble-autoselect`. Do **not** auto-rotate on transient
5xx-bursts that recover on retry — rotation is for permanent drift only.

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
```

## Output

- The resolved picks, one line each: `id  meanF1  cost  latency`.
- The proposed `settings.yaml` ensemble block (`model` / `second_model` /
  `third_model`).
- If `--apply-profile` was used: the old → new model-id diff.
- One line: "Run the `reset` MCP tool or restart Claude Code to reload."
- Long benchmark reports are NOT pasted into chat — they live under
  `<main-repo-root>/reports/llm-externalizer/`.

## Resources

- [selection-algorithm](references/selection-algorithm.md) — full hard filters,
  ranking rules, the 404 workflow, anti-patterns, and the code
  single-source-of-truth table.
- Code SoT (authoritative): `mcp-server/src/benchmark/discover.ts`
  (`DEFAULT_CRITERIA`, `qualify()`) and `mcp-server/src/benchmark/pick.ts`
  (`pickTopN()`, `DEFAULT_PICK_OPTIONS`, `applyPicksToSettings()`). Edit the
  code first, then mirror the change here.
