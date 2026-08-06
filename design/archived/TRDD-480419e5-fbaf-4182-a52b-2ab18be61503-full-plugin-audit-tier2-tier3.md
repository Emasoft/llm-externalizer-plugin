---
trdd-id: 480419e5-fbaf-4182-a52b-2ab18be61503
title: Full-plugin audit Tier 2 + Tier 3 follow-up
column: complete
created: 2026-05-01T00:00:00+0200
updated: 2026-08-06T17:35:00+0200
current-owner: claude-llm-externalizer
task-type: feature
---

# TRDD-480419e5-fbaf-4182-a52b-2ab18be61503 — Full-plugin audit Tier 2 + Tier 3 follow-up

**TRDD ID:** `480419e5-fbaf-4182-a52b-2ab18be61503`
**Filename:** `design/tasks/TRDD-480419e5-fbaf-4182-a52b-2ab18be61503-full-plugin-audit-tier2-tier3.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

**Status:** Partially complete — v9.9.0 shipped the highest-impact Tier-2 items (see "Completed in v9.9.0" below). Remaining items rescheduled to v9.10.0.
**Origin:** v9.8.0 release shipped every CRITICAL item + the highest-impact HIGH/MAJOR items from the four-agent full-plugin audit. The audit reports themselves live under `reports/full-plugin-audit/` (gitignored): 4 per-domain reports + 1 consolidated.

## Completed in v9.9.0 (2026-05-14)

**MCP server hardening (bf6ada3):**
- ✅ T2.8 — `default` branch returns `isError` envelope instead of throwing
- ✅ T2.9 — `fetchWithRetry429` captures body text before draining + rewraps Response
- ✅ T2.17 — `SECRET_PATTERNS` extended with wildcard `*_KEY`/`*_TOKEN`/`*_SECRET`/`*_PASSWORD` regex

**v9.8.0 auto-router repair (85f8417, audit SR-P1-001/002/003/004):**
- ✅ Fixed `awk '/^\*\*File:\*\*/'` pattern that never matched real MCP `scan_folder` reports (which emit `## File:`). Now uses multi-pattern grep covering all 3 known report shapes.
- ✅ Fixed per-bug serial-router always inspecting first `File:` line. Now awk state machine finds next-up unfixed bug.
- ✅ Removed `tr -d ' '` that stripped spaces from paths like `/Users/Name Surname/...`.
- ✅ Added `[[ -f "$report" ]]` existence check before `wc -l` to silence stderr.

**Pre-push hook hardening (a10415b):**
- ✅ T2.3 — `INTERPRETER_PREFIXES` whitelist + `_is_interpreter_token()` (no more naive "starts with python" → skip)
- ✅ T2.4 — `ps_query()` falls back to `/proc/<pid>/stat` on Linux; `"no-ps"` sentinel distinguishes "ps failed" from "found non-publish ancestor"
- ✅ T3-pp1 — `MAX_ANCESTRY_DEPTH` now reads `LLM_EXT_HOOK_MAX_DEPTH` env var (default 100, was hardcoded 40)

**Cross-platform launcher + statusline (70de7b6):**
- ✅ T2.2 — `/dev/tty` open uses `O_NONBLOCK` with `os.isatty()` short-circuit; `get_git_info()` now single-call `git status --porcelain=v1 --branch`; timeouts 3 s → 1 s
- ✅ `launcher.mjs:linkNodeModules` resolves both `dst` and `SCRIPT_DIR` via `path.resolve()` and uses `path.sep` (Windows safety, audit SR-P1-006)

**Diagnostic scripts (86f4007, T3.D1-T3.D3):**
- ✅ T3.D1 `scripts/diagnostics/check-mcp-server.py` — markdown PASS/FAIL table for plugin root, Node ≥20, better-sqlite3, settings.yaml, OpenRouter reachability
- ✅ T3.D2 `scripts/diagnostics/check-statusline.py` — pipes minimal JSON envelope to statusline; `--fix` re-runs installer
- ✅ T3.D3 `scripts/diagnostics/dump-state.py` — non-secret state collector with `SECRET_PATTERNS` mirror

## Remaining items (rescheduled to v9.10.0)

## Background

The audit swarm covered four surfaces (MCP TypeScript correctness, agents+commands+skills holistic, docs, platform/safety/diagnostics) and produced ~90 findings. v9.8.0 fixes:

- All 10 CRITICAL items.
- ~12 HIGH/MAJOR items selected for highest impact.

This TRDD tracks the remaining items deferred to v9.9.0.

### MCP server MAJOR — `mcp-server/src/` (still open)

| # | Finding | File:Line | Source |
|---|---------|-----------|--------|
| T2.6 | `await res.text()` and `await res.json()` are uncapped → OOM if remote returns gigabytes | `src/index.ts:2444, 2585, 2602, 2789, or-model-info.ts:189` | MCP M3 |
| T2.7 | watchFile fires mid-flight, mutates `currentBackend` without snapshot → wrong-token auth, reasoning-ladder downgrade desync | `src/index.ts:1494-1512, 5985-5997` | MCP M5 |
| T2.16 | `applyModelOverrides` runs before `filterBodyForSupportedParams` — overrides for unsupported fields are silently dropped with no warning | `src/index.ts:2563-2575, 2769-2775` | MCP M2 |
| T2.18 | `gitLsFilesMultiRepo` shells `git` with `cwd` from user input + 30 s timeout + `--recurse-submodules` (network-fetch risk + orphaned children) | `src/index.ts:771-867` | MCP M6 |
| T2.19 | `splitPerFileSections` regex header parser cross-matches `## File: /path.ts ## continued` → entire sections dropped silently | `src/grouping.ts:367, 389-421` | MCP M7 |
| T2.MCP-SDK | `Server` from `@modelcontextprotocol/sdk/server/index.js` is deprecated → migrate to `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` | `src/index.ts:39, 5045` | tsc deprecation (post-v9.9.0) |

### Pre-push hook (`.githooks/pre-push`)

(All Tier-2 pre-push items completed in v9.9.0 — see the Completed section above. Tier-3 items below are still open.)

### Statusline (`scripts/statusline/statusline.py`) — still open

(T2.2 — `/dev/tty` stall — was completed in v9.9.0 via `O_NONBLOCK` + `os.isatty()` short-circuit and the single-call git status. Below items remain.)

| # | Finding | File:Line | Source |
|---|---------|-----------|--------|
| T2.21 | `_log_exception` silently swallows secondary errors (ENOSPC, OSError) | `scripts/statusline/statusline.py:360-375` | security SC-P1-008 |
| T2.22 | No integrity check on the symlinked `node_modules` — interrupted install leaves a half-baked symlink that the fast-path check accepts | `scripts/hooks/install-mcp-deps.sh:114-132` (now in launcher.mjs but same risk) | security SC-P1-009 |
| T2.23 | `fetch_usage_from_api` / `fetch_openrouter_budget` fall back to stale cache without a TTL ceiling — revoked-token user sees old stats forever | `scripts/statusline/statusline.py:230-232, 251` | security SC-P1-010 |
| T2.24 | No migration hook between v9.5.x → v9.8.0 (stale `.publish.lock`, old `settings.yml`, half-installed node_modules) | (no migration script) | security SC-P1-011 |
| T2.25 | Locale-dependent `%-I:%M%p` formatting in statusline — empty am/pm on non-US locales | `scripts/statusline/statusline.py:324` | security SC-P1-012 |
| T2.26 | `git ls-files --others --exclude-standard` ignores submodule `.gitignore` — false "branch is dirty" indicator | `scripts/statusline/statusline.py:108-113` | security SC-P1-013 |

### README continuation (T1.8 remaining + T2.20)

The v9.8.0 README pass updated the badges + Features bullet block. The remaining sections need a coordinated rewrite:

- First-run § needs a new "0 · Run the setup wizard (recommended)" sub-section before the existing manual-backend options.
- "Plugin commands" tables: add `/llm-externalizer-setup`, `/llm-externalizer-install-statusline`. Title fix "Base commands (9)" → "Base commands (10)" or (11).
- "Agents" table: add `llm-externalizer-setup-agent`.
- "Plugin structure" tree: 5 → 11 skills, 7 → 19 commands, 5 → 6 agents.
- Add new wizard sub-section under § Troubleshooting (vLLM half-installed, Jan port collision, hf auth gated repos, paste-broke-my-YAML recovery).
- § First run options B-E: add Windows + WSL2 paths to every `~/.llm-externalizer/settings.yaml` reference.
- Add `build-snippet.py` mention under § Configuration (security property: stdlib-only safe YAML quoting).
- WSL2 `--include-wsl2-host` flag documented in Troubleshooting.
- Model-id recency check (CI gate hitting OpenRouter `/v1/models` before publish).
- `~17 GB` size estimate: tag with quant level (Q4_K_M / 4-bit MLX).
- Pre-scan secret detector troubleshooting wording cleanup.
- Cost-comparison image: caption with scan target size + measurement date.
- `keywords` in plugin.json: add `huggingface`, `setup-wizard`, `mass-scouting`, `vllm`, `llama-cpp`.

### Diagnostic scripts (T3.D1-T3.D3) — DONE in v9.9.0

All three scripts landed in commit 86f4007. See "Completed in v9.9.0" above. Final LOC came in at ~180 / ~125 / ~170 (vs. ~80 / ~50 / ~100 originally estimated) due to additional safety checks (binary detection, locale-aware date, OpenRouter timeout handling) and a richer markdown output.

### MCP server MINOR (15 items) + NIT (8 items)

`m1-m15` and `N1-N8` from the MCP TypeScript audit. Lowest impact tier; apply opportunistically.

### Agents+commands+skills MINOR (8) + NIT (4)

`N1-N8` and `T1-T4` from the agents+commands+skills audit.

### Platform LOW (5 items)

`SC-P1-014-018` from the security audit.

### Docs MINOR (9 items)

`N-1-N-9` from the docs audit.

## Acceptance criteria for v9.10.0

- All MAJOR items remaining above resolved or explicitly deferred-by-design (with rationale documented in the v9.10.0 CHANGELOG entry).
- MCP SDK `Server` → `McpServer` migration completed (resolves T2.MCP-SDK).
- README continuation (T1.8 cont. + T2.20) — wizard sub-section, command tables, agents table, plugin-structure tree, Windows/WSL2 paths, build-snippet mention.
- Re-run the four audit agents on the fixed state; the consolidated report should show no MAJOR / CRITICAL findings remaining.
- A README check that walks a new user through the setup wizard end-to-end without falling back to the README's outdated manual instructions.

End of TRDD.
