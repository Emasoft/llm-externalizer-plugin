# Changelog

All notable changes to this project will be documented in this file.
## [3.9.28] - 2026-04-08

### Changed

- Fix scan skill: add required sections, self-contained references

Pass CPV validation: 0 MAJOR, 0 MINOR, 0 CRITICAL.

## [3.9.27] - 2026-04-08

### Changed

- Add cost comparison chart to README

Shows actual cost per project scan: Opus $2.53, Sonnet $0.51,
Ensemble $0.08 (32x cheaper). Based on real session data
scanning 8 TypeScript source files (88K input, 16K output tokens).

## [3.9.26] - 2026-04-08

### Changed

- Add project scan skill, update rules file

- New skill: llm-externalizer-scan — triggers on "scan project",
  "audit codebase", "full scan". Guides Claude through a full
  ensemble scan with proper parameters.
- Update ~/.claude/rules/use-llm-externalizer.md: fix stale values
  (115s→600s timeout, 2-model→3-model ensemble, add Qwen pricing,
  fix scan_folder defaults, add model fallback docs).

## [3.9.24] - 2026-04-08

### Changed

- Update README: 3-model ensemble with pricing, rate limiting, timeout fixes

- Document all 3 ensemble models (Gemini, Grok, Qwen) with pricing
- Add model fallback behavior (1-2 fail → partial results)
- Add rate limiting section (adaptive AIMD, auto-detected RPS)
- Fix timeout: 600s base, extended for reasoning models
- Remove stale 115s/120s references

## [3.9.23] - 2026-04-08

### Changed

- Remove deprecated qwen3.6-plus:free model variant

The free variant was deprecated by OpenRouter in April 2026.
Remove from KNOWN_MODEL_LIMITS. Paid qwen/qwen3.6-plus remains.

## [3.9.22] - 2026-04-07

### Changed

- Expand default directory exclusions in walkDir

Add .idea, .vscode, tmp, temp, .gradle, .cargo, vendor, out,
.output, bower_components, .pnpm-store, .eggs, .nx to
WALK_DEFAULT_EXCLUDE. These are non-project directories that
should never be scanned by default.

## [3.9.21] - 2026-04-07

### Changed

- Increase OpenRouter default timeout from 120s to 600s

Reasoning models (Qwen 3.6 Plus, etc.) need extended thinking time.
120s was too short — models would time out during the thinking phase.
600s base timeout + dynamic extension when reasoning tokens are flowing.

## [3.9.20] - 2026-04-07

### Changed

- Fix reasoning model timeout: detect thinking tokens, extend timeout dynamically

- Remove 115s hard cap (MCP_MAX_TIMEOUT_MS) — use profile timeout (300s default)
- Detect reasoning/thinking tokens in SSE stream (delta.reasoning, delta.reasoning_content)
- When reasoning tokens are actively flowing, suspend the soft timeout — model is working
- Don't retry when reasoning was detected but content is empty — retrying restarts thinking
- Progress notifications show "Reasoning… Xs (model is thinking)" during thinking phase
- Fixes Qwen 3.6 Plus truncation on large files (was timing out during thinking phase)

## [3.9.19] - 2026-04-07

### Changed

- Add BREVITY_RULES to all LLM system prompts

Instructs models to be succinct (bullets, no preamble, only
report findings, max 3 sentences per finding). Prevents
verbose output that wastes tokens and causes truncation on
weaker models like Qwen 3.6 Plus.

## [3.9.18] - 2026-04-07

### Changed

- Remove user-facing concurrency options, update docs

Rate limiting is now fully automatic — no max_concurrent,
max_in_flight, or max_rps profile fields needed.

## [3.9.16] - 2026-04-07

### Fixed

- Llm-ext help — note absolute paths recommended, report save location

## [3.9.15] - 2026-04-07

### Fixed

- Llm-ext event-driven handshake + line buffering + error handling

## [3.9.14] - 2026-04-07

### Fixed

- Llm-ext MCP handshake — add initialized notification + stream parsing

## [3.9.13] - 2026-04-07

### Documentation

- Add copy-paste snippet for enabling llm-ext in plugin agents

## [3.9.12] - 2026-04-07

### Added

- Llm-ext CLI with built-in tool discovery via --help

## [3.9.11] - 2026-04-07

### Added

- Add bin/llm-ext CLI wrapper for plugin agents

## [3.9.10] - 2026-04-07

### Added

- Add bin/llm-externalizer standalone launcher

## [3.9.9] - 2026-04-07

### Documentation

- Add subagent access guide for plugin-shipped agents

## [3.9.8] - 2026-04-05

### Changed

- Remove ensemble deadline — user will extend MCP timeout instead

## [3.9.7] - 2026-04-05

### Fixed

- 3-model ensemble deadline prevents MCP timeout on large files

## [3.9.6] - 2026-04-05

### Fixed

- Add types:["node"] to tsconfig to resolve IDE false positives

## [3.9.5] - 2026-04-05

### Fixed

- Publish.py cleanup + README steps updated

## [3.9.4] - 2026-04-05

### Added

- Publish.py always bumps version first, then validates

## [3.9.3] - 2026-04-05

### Fixed

- Simplify lock file protocol — existence = validation passed

## [3.9.2] - 2026-04-05

### Added

- Pre-push hook skips when publish.py running, CPV now mandatory

## [3.9.1] - 2026-04-05

### Added

- Unify pre-push hook with publish.py --check-only

## [3.9.0] - 2026-04-05

### Added

- 3-model ensemble support (third_model)

### Fixed

- Cpv-remote-validate uses 'plugin' not 'cpv-validate'
- Use cpv-remote-validate for isolated CPV execution

## [3.8.8] - 2026-04-02

### Fixed

- Schema required arrays block folder_path-only calls

## [3.8.7] - 2026-04-02

### Fixed

- Resolve remaining deferred audit issues + dead code cleanup

## [3.8.6] - 2026-03-30

### Documentation

- Comprehensive update for v3.8 features

### Fixed

- Trim SKILL.md to <4000 chars, embed all 19 usage-patterns TOC headings

## [3.8.5] - 2026-03-30

### Fixed

- Address 10 issues from full src audit (CC-P3-001 through CC-P3-012)

## [3.8.4] - 2026-03-30

### Miscellaneous

- Remove old bash pre-push hook (replaced by .githooks/pre-push in Python)

## [3.8.3] - 2026-03-30

### Fixed

- Address 11 issues from second audit (CC-P2-001 through CC-P2-011)

## [3.8.2] - 2026-03-30

### Fixed

- Address 10 issues from code correctness audit

## [3.8.1] - 2026-03-30

### Fixed

- ReDoS protection, git ls-files flag incompatibility, unused param

## [3.8.0] - 2026-03-30

### Added

- Compare_files batch mode + git diff mode + grouping

## [3.7.2] - 2026-03-30

### Added

- Respect gitignore across submodules and nested git repos

## [3.7.1] - 2026-03-30

### Added

- Add folder_path support to batch_check (last tool missing it)

## [3.7.0] - 2026-03-30

### Added

- Add folder_path to chat, code_task, check_references, check_imports

## [3.6.4] - 2026-03-30

### Fixed

- Scan_folder use_gitignore description said 'Default: false' but code defaults to true

## [3.6.3] - 2026-03-30

### Fixed

- Raise max_files default from 1000 to 2500

## [3.6.2] - 2026-03-28

### Fixed

- Explain WHY file grouping saves tokens in all tool descriptions

## [3.6.1] - 2026-03-28

### Fixed

- Add FILE GROUPING section to all tool descriptions

## [3.6.0] - 2026-03-28

### Added

- Convert all bash scripts to Python for cross-platform support

### Fixed

- Update last setup.sh reference in README to setup.py

### Miscellaneous

- Remove bash scripts replaced by Python equivalents

## [3.5.3] - 2026-03-28

### Fixed

- Use numbered checklist, remove colon after 'Trigger with', comma-separated TOC
- Resolve remaining CPV issues — numbered steps, TOC format, description format
- Resolve all CPV validation issues (6 MINOR + 6 WARNING)
- CPV must pass with 0 issues to allow publish

## [3.5.2] - 2026-03-28

### Added

- Add CPV remote validation to publish pipeline

### Fixed

- Parse CPV output for severity instead of relying on exit codes

## [3.5.1] - 2026-03-28

### Documentation

- Update README for v3.3–v3.5 features

## [3.5.0] - 2026-03-28

### Added

- Add redact_regex parameter to all content tools

## [3.4.0] - 2026-03-28

### Added

- Add max_retries parameter to all content tools, deprecate batch_check

### Documentation

- Add max_retries to tool reference, mark batch_check as deprecated

## [3.3.1] - 2026-03-28

### Fixed

- Filter group markers from secret scans and single-file checks

## [3.3.0] - 2026-03-28

### Added

- Add file grouping support for isolated batch processing

### Documentation

- Add file grouping documentation to skill references

## [3.2.9] - 2026-03-28

### Changed

- Update plugin for Claude Code v2.1.80–v2.1.86 compatibility

- statusline: use rate_limits from input JSON (v2.1.80+) instead of
  OAuth token lookup + API call; falls back to API for older versions
- commands: add effort frontmatter (v2.1.76) — discover:low, configure:medium
- docs: add check_against_specs to tool reference, usage patterns,
  decision tree, and skill trigger list (was added in v3.2.8 but
  undocumented in skill files)

### Fixed

- Statusline mkdir race + docs inconsistencies

## [3.2.8] - 2026-03-26

### Added

- Add check_spec tool — compare source files against a specification

### Fixed

- Max_files default 1000, useGitignore default true
- Apply rechecker fixes [rechecker: skip]
- Remove stale max_tokens references from tool descriptions

### Refactored

- Rename check_spec → check_against_specs + folder scanning

## [3.2.7] - 2026-03-26

### Added

- Global service health tracker + truncation in output reports
- Auto-retry on truncated LLM responses (up to 3 retries)

### Miscellaneous

- Gitignore tldr session artifacts
- Add Serena project config, remove stale worktrees

### Refactored

- Remove ensemble and max_tokens from tool parameters

## [3.2.6] - 2026-03-23

### Added

- Configurable max_payload_kb on all tools + FFD bin packing

### Fixed

- Comprehensive adversarial audit — 32 findings across all severity levels
- 800 KB payload budget for batching — guarantees full ensemble

## [3.2.5] - 2026-03-15

### Fixed

- Rebuild dist after version sync in publish.py

## [3.2.3] - 2026-03-15

### Added

- Bundle all dependencies with esbuild for standalone dist/

## [3.2.2] - 2026-03-15

### Documentation

- Update install instructions with marketplace update step

### Fixed

- Remove env block from .mcp.json to fix missing env var error
- Comprehensive audit — security hardening, version sync, skill structure, CI
- Commit dist/, sync versions, harden publish pipeline
- Add cliff.toml and harden publish.py changelog generation

## [3.2.1] - 2026-03-15

### Changed

- Fix moderate vulnerability: update hono 4.12.5 -> 4.12.8

Resolves GHSA prototype pollution in hono's parseBody({ dot: true }).
Transitive dependency via @modelcontextprotocol/sdk. Patched in 4.12.7,
updated to 4.12.8. npm audit now shows 0 vulnerabilities.
- Improve README with badges, detailed tool docs, and publishing guide

Add shields.io badges (version, build, typescript, node, license,
marketplace) with badges-start/end markers. Expand MCP tools section
with input fields, ensemble parameters, and constraints. Add profile
modes table, environment variables reference, quick start configs for
both OpenRouter and LM Studio. Document publish.py steps and pre-push
hook checks. Add requirements table and full directory tree.
- Update .gitignore to match marketplace plugin conventions

Add patterns for: .claude/, CLAUDE.md, .tldr/, *_dev/ (generic), IDE
files (.idea/, .vscode/), Python caches (.ruff_cache/, .mypy_cache/,
.pytest_cache/), build artifacts, security output, and editor swap files.
Matches Emasoft/claude-plugins-management .gitignore pattern.
- Add CI/CD scripts and fix plugin naming convention

- Rename plugin from 'llm-externalizer-plugin' to 'llm-externalizer'
  (repo name stays llm-externalizer-plugin, matching token-reporter pattern)
- Add homepage field to plugin.json
- Add notify-marketplace.yml GitHub Action (triggers emasoft-plugins update)
- Add publish.py release pipeline (bump, changelog, tag, push, gh release)
- Add bump_version.py for semver bumps in plugin.json
- Add pre-push git hook (TypeScript build check + manifest validation)
- Rewrite README with comprehensive installation instructions, naming
  section, directory structure, and publishing guide
- Update .gitignore to include dev folders
- Apply validation fixes from plugin-validator and skill-reviewers

Fixes:
- server.json: version 3.1.0 -> 3.2.0, settings.yml -> settings.yaml
- Both SKILL.md descriptions: rewritten to third-person trigger phrases
- Config SKILL.md: added troubleshooting table, CLI commands section,
  fixed agent-directed phrasing in auth resolution section
- Usage SKILL.md: added instructions_files_paths guidance, enhanced
  output location constraint, added examples/ pointer
- New: examples/end-to-end-workflow.md with complete tool selection,
  invocation, output reading, and decision tree
- Initial plugin structure for llm-externalizer-plugin

Claude Code plugin packaging of the LLM Externalizer MCP server.

Components:
- .claude-plugin/plugin.json: Plugin manifest (v3.2.0)
- .mcp.json: MCP server config using $CLAUDE_PLUGIN_ROOT
- mcp-server/: Bundled MCP server source (copied from llm_externalizer)
- skills/llm-externalizer-usage/: Tool selection, patterns, constraints
- skills/llm-externalizer-config/: Profile management, settings, ensemble
- commands/discover.md: Health check command
- commands/configure.md: Profile management command
- scripts/setup.sh: Build script (npm install + tsc)
- scripts/install-statusline.sh: Optional statusline integration


