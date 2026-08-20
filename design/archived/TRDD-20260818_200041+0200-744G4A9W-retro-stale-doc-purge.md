---
trdd-id: 744G4A9W
title: Retro-card — purge wrong group name and dead MCP claim from shipped surfaces
column: complete
created: 2026-08-18T20:00:41+0200
updated: 2026-08-18T20:00:41+0200
current-owner: llm-externalizer-claude
task-type: docs
approval-tier: 0
release-via: publish
implementation-commits: [b1f008f]
---

# Retro-card: stale-doc purge (config→settings, dead MCP claim)

Retroactive card (hub governance requirement, Phase-2 dispatch
2026-08-18): the fix landed before its card; this TRDD restores the
blame → commit → TRDD → finding chain.

## Audit findings cited

`reports/plugin-self-audit/DELEGATION.md`, Unit 1:
- **F3** (highest blast radius in the audit): the shipped
  `rules/use-llm-externalizer.md:5` — installed into `~/.claude/rules/`
  and read by EVERY session on the machine — named the 7th CLI group
  `config`; verified live: `llm-ext config show` exits 1,
  `llm-ext settings show` exits 0.
- **F2**: `llm-ext models replacements --help` still asserted "the MCP
  server is read-only by design"; the MCP server was deleted in d557c68
  and MCP is banned outright.

## What shipped (b1f008f)

`config`→`settings` in the shipped rule; the help string reworded to the
surviving invariant ("this command is read-only by design and never
mutates settings") in `mass_scouting/mcp-tools.ts`; dist rebuilt.
Installed copies (`~/.claude/rules/use-llm-externalizer.md`,
`~/.claude/CLAUDE.md:330`) were fixed in place the same day.

## Verification performed

Real invocations (not `--help` existence checks) proved the group
names; `./bin/llm-ext models replacements --help` grep: 0 hits for the
stale clause, 1 for the new one.

## Notes and lessons learned

- The installed rule copy was observed re-synced back to the cached
  13.5.5 text (`config`) within the hour — the plugin sync clobbers
  in-place fixes to `~/.claude/rules/`. The durable fix is the repo copy
  shipping in v13.5.6; do not fight the sync by re-editing the installed
  copy.

## Approval log

- 2026-08-18T20:00:41+0200 — COMPLETE (retro). Fix verified and
  committed as b1f008f; shipping in v13.5.6.
