---
trdd-id: ME1CAHG4
title: Retro-card — global boolean flags no longer swallow the following positional
column: complete
created: 2026-08-18T20:00:41+0200
updated: 2026-08-18T20:00:41+0200
current-owner: llm-externalizer-claude
task-type: bugfix
approval-tier: 0
release-via: publish
implementation-commits: [51d46bb]
---

# Retro-card: launcher global-flag positional swallowing

Retroactive card (hub governance requirement, Phase-2 dispatch
2026-08-18): the fix landed before its card; this TRDD restores the
blame → commit → TRDD → finding chain.

## Audit finding cited

`reports/plugin-self-audit/DELEGATION.md` — CONFIRMED, root cause at
`scripts/llm-ext/src/cli/launcher.ts:221`: `flagTakesValue()` assumed
every schema-unknown flag takes a value, but `--quiet`/`--estimate`/
`--preview` are GLOBAL flags handled in main.ts and appear in no tool's
`inputSchema.properties`, so they swallowed the following positional.
The audit also showed the defense comment at launcher.ts:210-214 was
false for this class, and that both existing `--quiet` tests placed the
flag AFTER the positional, keeping the suite green over the broken
ordering.

## What shipped (51d46bb)

Exported `GLOBAL_BOOLEAN_FLAGS` const checked first in
`flagTakesValue()` (never consumes a token); corrected the false
comment; keep-in-sync comments at the main.ts sites; new test iterating
the const with each flag BEFORE the positional. `--profile` excluded by
design (value-taking, stripped by `extractProfileFlag` before the
launcher runs — verified main.ts:437 vs :458).

## Verification performed

24/24 launcher tests; tsc + build clean;
`./bin/llm-ext session compact --quiet /nonexistent/x.jsonl` now fails
naming the path (positional captured), offline, no LLM send.

## Notes and lessons learned

## Approval log

- 2026-08-18T20:00:41+0200 — COMPLETE (retro). Fix verified and
  committed as 51d46bb; shipping in v13.5.6.
