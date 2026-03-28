# Changelog

All notable changes to this project will be documented in this file.
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


