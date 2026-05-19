---
name: llm-externalizer-codex-scan
description: |-
  Externalize a code scan to OpenAI GPT-5.5 via the Codex CLI when the user wants
  the OpenAI model specifically (not OpenRouter, not local). Falls back to Opus
  on rate-limit. Use when the user asks for "scan with codex", "scan with
  gpt 5.5", "use my codex quota", or wants to compare GPT-5.5 findings against
  the OpenRouter ensemble. Trigger with /llm-externalizer-codex-scan or "scan
  with codex".
argument-hint: "[folder] [--files ...] [--ext .py,.ts] [--out-dir path] [--max-bytes N]"
effort: medium
---

## Overview

Run a per-file code scan through **OpenAI GPT-5.5 via the Codex CLI** instead of the MCP server's OpenRouter / local backends. Output is in the same shape as the existing `scan_folder` reports — per-batch markdown files under `$MAIN_ROOT/reports/llm-externalizer/` — so the existing parallel-fixer / serial-fixer agents work on the output without modification.

### When to trigger

- User explicitly asks for Codex / GPT-5.5 (the OpenAI model)
- User says "use my codex quota" / "use my openai account"
- User wants to compare GPT-5.5 findings against the OpenRouter ensemble or a local model
- User wants the loop-until-fixed workflow (phase 2 — track TRDD-807c1e2d)

### When NOT to trigger

- User wants the OpenRouter ensemble or a local model → use the `llm-externalizer-scan` skill instead
- User wants free / cheap scanning → use `--free` on the standard scan
- User wants pure structural validation (no LLM) → use `claude plugin validate .`

## Prerequisites

- `codex` on PATH (`npm install -g @openai/codex`)
- Codex authenticated (`codex login`)
- `multi_agent = true` in `~/.codex/config.toml` (the wrapper sets this automatically if missing)
- For Opus fallback: nothing extra — uses Claude Code's Agent tool

## Instructions

Copy this checklist and track your progress:

1. [ ] Parse the user's request for **target** (folder OR explicit file list), **extension filter** (`--ext`), **output dir** (optional), **fallback policy** (`--no-fallback` means abort instead of falling back to Opus).
2. [ ] If the user did NOT mention Codex or GPT explicitly, ask: "Did you want to use Codex/GPT-5.5 specifically, or the standard scan (OpenRouter ensemble or local)?" — don't silently route to Codex.
3. [ ] Run the slash command: `/llm-externalizer:llm-externalizer-codex-scan <args>`.
4. [ ] The command's wrapper handles file discovery, FFD bin-packing, Codex invocation, rate-limit detection, and Opus fallback.
5. [ ] Watch the wrapper's stdout for report file paths.
6. [ ] If any reports were created via Opus fallback (filenames ending in `-opus-pending.md`), check `.claude/llm-externalizer-codex-fallback/` for markers and dispatch one Opus subagent per marker via the Task tool.
7. [ ] Report only the report paths back to the orchestrator. Do NOT read or summarize report contents.

## Output

Per-batch markdown reports under `$MAIN_ROOT/reports/llm-externalizer/`:

```
$MAIN_ROOT/reports/llm-externalizer/<timestamp>-codex-scan-batch-001.md
$MAIN_ROOT/reports/llm-externalizer/<timestamp>-codex-scan-batch-002.md
...
```

Each report is a sequence of `## File: <path>` sections matching the shape that `splitPerFileSections` (mcp-server/src/grouping.ts) expects, so the existing parallel-fixer agent can pick up any of these reports without modification.

## Error Handling

### Limitations

- **GPT-5.5 prompts are pinned** in `scripts/codex/codex-scan-prompts.md`. Do NOT edit them — they are calibrated for OpenAI's response style and the wrapper's parser depends on the exact output shape. If you need a different prompt, write a new template file alongside this one.
- **No conversation state.** Each Codex invocation is a single chat turn. Multi-turn refinement (clarifying questions, follow-ups) is not supported by this wrapper.
- **Rate-limit detection is heuristic.** The wrapper greps Codex's stderr / stdout for known patterns (`rate limit`, `429`, `quota exceeded`, etc.). False positives trigger fallback (no real harm), false negatives leave the user with a cryptic Codex error.
- **Phase 1 only.** Loop-until-fixed (`--fix-loop N`) is not yet implemented. Track TRDD-807c1e2d for the design.

### Failure modes

- **Codex not installed:** Wrapper prints installation instructions; aborts unless Opus fallback is enabled.
- **Codex not authenticated:** Wrapper returns the Codex error verbatim. Tell the user to run `codex login`.
- **`multi_agent` not in config:** Wrapper sets it automatically; logs the action to stderr.
- **Codex rate-limited:** Wrapper falls back to Opus for the current batch and all remaining batches. Earlier batches that succeeded stay as Codex results — no rework.
- **Both Codex and Opus fail:** Wrapper exits 2 with a stderr summary. No reports written for the failed batches.

## Examples

```bash
# Scan the src/ folder for Python + TypeScript files
/llm-externalizer:llm-externalizer-codex-scan src/ --ext .py,.ts

# Scan an explicit file list with fallback disabled
/llm-externalizer:llm-externalizer-codex-scan --files src/auth.py src/db.py --no-fallback

# Override the output directory
/llm-externalizer:llm-externalizer-codex-scan src/ --out-dir reports/codex-prerelease/
```

After any scan completes, the user can run:

```
/llm-externalizer:llm-externalizer-fix-report <report-path>
```

That dispatches the existing parallel-fixer agent (Sonnet or Opus, user-chosen) to verify and fix the findings in that report.

## Resources

- Related slash command: `/llm-externalizer:llm-externalizer-codex-scan` — the canonical entry point.
- Related skill: `llm-externalizer-scan` — the standard scan via OpenRouter ensemble / local backend.
- Related skill: `llm-externalizer-fix-report` — fixes findings emitted by this scan.
- TRDD-807c1e2d — design tracker for Phase 2 (loop-until-fixed).
- OpenAI Codex CLI: `https://github.com/openai/codex` (install via `npm install -g @openai/codex`).
