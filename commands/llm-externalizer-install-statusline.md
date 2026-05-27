---
name: llm-externalizer-install-statusline
description: Install the LLM Externalizer multi-tier Claude Code statusline (model + context bar + MCP tokens/cost + OpenRouter credits + 5h/7d limits, with width-aware tiering and per-section error isolation).
allowed-tools:
  - Bash
argument-hint: ""
effort: low
---

Install (or refresh) the LLM Externalizer statusline by running
`scripts/install_statusline.py`. The Python installer mirrors
`scripts/statusline/install.sh` exactly and works on macOS / Linux / Windows.

The installer:

1. Copies `scripts/statusline/statusline.py` → `~/.claude/statusline.py` (chmod 0755), with content-aware skipping when up to date.
2. Backs up any existing destination + the previous `settings.json` to `*.bak.<YYYYMMDD_HHMMSS+TZ>`.
3. Atomically patches `~/.claude/settings.json` to:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "python3 ~/.claude/statusline.py",
       "refreshInterval": 3
     }
   }
   ```

   `refreshInterval: 3` makes the bar re-tier within 3 s of a terminal resize.

What the statusline shows (each section is in its own try/except, so a partial failure can never blank the bar):

- 🤖 Model name + Claude Code version (cached 1 h) + `·max` effort + 🧠 thinking
- 📁 cwd basename + 🌳 worktree (if any) + 🌿 git branch (red `*` when dirty)
- 📊 Context-window bar with `current/size %`
- 🔌 LLM Externalizer MCP cumulative tokens + 💰 cumulative cost (USD)
- 🏦 **OpenRouter remaining credit balance** (live, 5-min cache, requires `OPENROUTER_API_KEY` in the user's shell environment)
- ⏱️ 5-hour and 📅 7-day Claude Code utilisation bars + reset times
- 💰 Extra-usage credit bar when extra-usage is enabled on the account

Width tiering (1 line ≥ 184 cols → 6 lines < 65 cols) is automatic — the bar never drops content, it just wraps to more rows.

## Steps

1. Run the installer:

   ```bash
   python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install_statusline.py"
   ```

   To override the 3-second refresh cadence:

   ```bash
   REFRESH_INTERVAL=5 python3 "${CLAUDE_PLUGIN_ROOT}/scripts/install_statusline.py"
   ```

2. Show the installer's stdout verbatim — it prints `==>` lines for the source / dest / settings paths, the chosen refresh interval, every backup it made, and the final `statusLine.command` it wrote.

3. Tell the user to **restart Claude Code** if the new bar does not appear immediately — settings changes can require a session restart to register, even with `refreshInterval` set.

4. Mention that the OpenRouter balance (🏦) only renders when `OPENROUTER_API_KEY` is in the user's shell environment. The plugin's `userConfig.openrouter_api_key` exports the key to the MCP server but **not** to the statusline subprocess; for the budget panel the user must also have it in their shell rc (zsh/bash/fish) — the keychain copy alone is insufficient.

## Three-surface compliance: by-design slash-only (GAP-14)

This command is a one-shot file installer: it writes the statusline script to `~/.claude/statusline.py` and atomically patches `~/.claude/settings.json` — both OUTSIDE the project tree, in the user's global Claude Code config. A `llm-externalizer install-statusline` CLI verb could be added (the underlying installer is already `scripts/install_statusline.py`, a standalone Python script), but the slash command is one-line trivial so the dual-CLI work is low-priority.

Per TRDD-a24b213c §C, this is a documented exemption from the "every capability has MCP tool + CLI command + slash command" invariant — not a gap waiting to be filled. An MCP tool is ruled out because the server is read-only and cannot write to the user's home directory. A future CLI verb is feasible but not blocking; closing GAP-14 fully would mean adding the verb to `bin/llm-ext` for shell-script callers, while the slash command remains the canonical interactive surface.

## Failure modes

- `Error: statusline source not found` → plugin install did not pull `scripts/statusline/statusline.py`. Run `scripts/setup.py` or reinstall the plugin.
- `Error: ~/.claude does not exist` → the user has never launched Claude Code on this machine. Tell them to run it once first, then re-invoke this command.
- `Error: ~/.claude/settings.json is not valid JSON` → the user has a corrupt settings.json. The installer refuses to overwrite. Tell the user to fix or remove the file, then re-invoke.
- `Error: REFRESH_INTERVAL must be an integer` → the env var is non-numeric. Set it to a positive integer (seconds) or unset to use the 3-s default.
- Statusline installs but does not appear → restart Claude Code; `/config` shows the active statusLine block.
