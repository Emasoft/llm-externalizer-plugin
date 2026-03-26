# Changelog

All notable changes to this project will be documented in this file.
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


