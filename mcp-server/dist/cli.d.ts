#!/usr/bin/env node
/**
 * CLI for LLM Externalizer.
 *
 * NOTE: Profile-mutating subcommands (add / select / edit / remove / rename)
 * are DISABLED by design. Model and profile configuration is user-only —
 * the user must edit ~/.llm-externalizer/settings.yaml manually with an
 * editor, then either restart Claude Code or call the MCP "reset" tool to
 * reload. Read-only subcommands (list, model-info, search-existing) remain
 * available.
 *
 * Usage:
 *   npx llm-externalizer profile list
 *   npx llm-externalizer model-info <model-id> [options]
 *   npx llm-externalizer search-existing "<description>" [<src-files>...] --in <path>
 */
export {};
