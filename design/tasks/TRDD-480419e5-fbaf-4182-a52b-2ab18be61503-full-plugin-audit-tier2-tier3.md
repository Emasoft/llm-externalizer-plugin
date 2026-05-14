# TRDD-480419e5-fbaf-4182-a52b-2ab18be61503 — Full-plugin audit Tier 2 + Tier 3 follow-up

**TRDD ID:** `480419e5-fbaf-4182-a52b-2ab18be61503`
**Filename:** `design/tasks/TRDD-480419e5-fbaf-4182-a52b-2ab18be61503-full-plugin-audit-tier2-tier3.md`
**Tracked in:** this repo (design/tasks/ is git-tracked)

**Status:** Open — proposed work, scheduled for v9.9.0.
**Origin:** v9.8.0 release shipped every CRITICAL item + the highest-impact HIGH/MAJOR items from the four-agent full-plugin audit. The audit reports themselves live under `reports/full-plugin-audit/` (gitignored): 4 per-domain reports + 1 consolidated.

## Background

The audit swarm covered four surfaces (MCP TypeScript correctness, agents+commands+skills holistic, docs, platform/safety/diagnostics) and produced ~90 findings. v9.8.0 fixes:

- All 10 CRITICAL items.
- ~12 HIGH/MAJOR items selected for highest impact.

This TRDD tracks the remaining items deferred to v9.9.0.

## Items deferred to v9.9.0

### MCP server MAJOR — `mcp-server/src/`

| # | Finding | File:Line | Source |
|---|---------|-----------|--------|
| T2.6 | `await res.text()` and `await res.json()` are uncapped → OOM if remote returns gigabytes | `src/index.ts:2444, 2585, 2602, 2789, or-model-info.ts:189` | MCP M3 |
| T2.7 | watchFile fires mid-flight, mutates `currentBackend` without snapshot → wrong-token auth, reasoning-ladder downgrade desync | `src/index.ts:1494-1512, 5985-5997` | MCP M5 |
| T2.8 | `default` branch in CallToolRequestSchema throws → wrong error envelope (logs phantom error attributed to typo'd tool name) | `src/index.ts:8702-8703` | MCP M8 |
| T2.9 | `fetchWithRetry429` consumes the response body once, then returns it; caller sees empty error message after retry exhaustion | `src/index.ts:2173-2179, 2098-2181` | MCP M9 |
| T2.16 | `applyModelOverrides` runs before `filterBodyForSupportedParams` — overrides for unsupported fields are silently dropped with no warning | `src/index.ts:2563-2575, 2769-2775` | MCP M2 |
| T2.17 | `SECRET_PATTERNS[5]` env-secret regex misses common names (JWT_SECRET, STRIPE_SECRET_KEY, LM_API_TOKEN) | `src/index.ts:355-358` | MCP M4 |
| T2.18 | `gitLsFilesMultiRepo` shells `git` with `cwd` from user input + 30 s timeout + `--recurse-submodules` (network-fetch risk + orphaned children) | `src/index.ts:771-867` | MCP M6 |
| T2.19 | `splitPerFileSections` regex header parser cross-matches `## File: /path.ts ## continued` → entire sections dropped silently | `src/grouping.ts:367, 389-421` | MCP M7 |

### Pre-push hook (`.githooks/pre-push`)

| # | Finding | File:Line | Source |
|---|---------|-----------|--------|
| T2.3 | Pre-push regex can be bypassed via symlinked publish.py to writable paths | `.githooks/pre-push:123-138, 159-176` | security SC-P1-006 |
| T2.4 | Pre-push fails on minimal containers (no `ps`); needs `/proc/<pid>/stat` fallback | `.githooks/pre-push:108-115` | security SC-P1-003 |
| T3-pp1 | MAX_ANCESTRY_DEPTH=40 hardcoded; exotic shells can stack > 40 frames | `.githooks/pre-push:42` | security SC-P1-014 |

### Statusline (`scripts/statusline/statusline.py`)

| # | Finding | File:Line | Source |
|---|---------|-----------|--------|
| T2.2 | `/dev/tty` open can stall 3-5 s per 3 s refresh on detached sessions; git also stalls (3 subprocesses × 3 s timeout × every refresh) | `scripts/statusline/statusline.py:584-588, 102-114` | security SC-P1-005 |
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

### Diagnostic scripts proposed (T3.D1-T3.D3)

| # | Script | Purpose | Est. LOC |
|---|--------|---------|----------|
| T3.D1 | `scripts/diagnostics/check-mcp-server.py` | Probe MCP server health from CLI (`better-sqlite3` resolves, settings.yaml valid, OpenRouter reachable) | ~80 |
| T3.D2 | `scripts/diagnostics/check-statusline.py` | Verify settings.json wiring; pipe minimal JSON; check exit code; dump statusline-error.log tail | ~50 |
| T3.D3 | `scripts/diagnostics/dump-state.py` | Collect non-secret state for bug reports (with explicit redaction sweep) | ~100 |

### MCP server MINOR (15 items) + NIT (8 items)

`m1-m15` and `N1-N8` from the MCP TypeScript audit. Lowest impact tier; apply opportunistically.

### Agents+commands+skills MINOR (8) + NIT (4)

`N1-N8` and `T1-T4` from the agents+commands+skills audit.

### Platform LOW (5 items)

`SC-P1-014-018` from the security audit.

### Docs MINOR (9 items)

`N-1-N-9` from the docs audit.

## Acceptance criteria for v9.9.0

- All Tier-2 items above resolved or explicitly deferred-by-design (with rationale documented in the v9.9.0 CHANGELOG entry).
- Re-run the four audit agents on the fixed state; the consolidated report should show no MAJOR / CRITICAL findings remaining.
- A README check that walks a new user through the setup wizard end-to-end without falling back to the README's outdated manual instructions.

End of TRDD.
