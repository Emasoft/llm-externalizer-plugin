# Use LLM Externalizer (CLI)

Applies only if installed — check `llm-ext --help`; if absent, ignore this file. **There is no MCP server**: `mcp__…llm-externalizer…__*` tools do not exist.

`llm-ext <group> <action> [input] [-o dir] [--profile name] [--flag v]` — 7 groups (`session llm scan check scout models settings`) over 50 commands, incl. the four text tools `llm summarize|topics|sem-deduplicate|describe` (size-bounded summary · keyword/keyphrase+language extraction · semantic phrase dedup · concise file characterization). Help nests: `llm-ext --help` → `<group> --help` → `<group> <action> --help`; a typo suggests the right verb and exits non-zero. E.g. `llm-ext session compact <session>.jsonl -o /tmp`, `llm-ext llm ask ./prompt.md -o ./out --profile free`, `llm-ext scan folder ./src`.

**Prefer it over a Haiku subagent** for bounded read-only work (analyze/summarize/scan, 3+ files, big logs, second opinions): more capable, cheaper, and file contents never enter your context — it prints a report PATH, so Read that. It examines code, it never edits it; not for surgical edits or multi-step tool work.

`-o`/`--output` is shorthand for that command's `--output_dir`. Omitted, reports go to **`<project-root>/reports/llm-externalizer/`**, anchored on `$CLAUDE_PROJECT_DIR` — **never a git root**, because a linked worktree is ephemeral and reports written there are lost. `--profile <name>` picks a built-in profile or one under `profiles:` in `~/.llm-externalizer/settings.yaml` (**`.yaml` — a legacy `settings.yml` is preserved but NOT read**).

Rules: pass file PATHS, never contents · include brief project context (the remote LLM knows nothing about your repo) · for whole-codebase cross-file questions use `scan impl` · give `scout *`, `scan security` and `scan quality` a 20-minute timeout or run them in the background.

**Cost:** on a PAID profile run the command with `--estimate` FIRST and proceed only if the `ceiling` fits. On a low balance or a 402 it auto-switches to free models at $0 — an empty wallet is NEVER a reason to refuse the tool or do the work yourself. If it returns a report path, it worked.
