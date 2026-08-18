---
trdd-id: WIO13P1P
title: Deadweight sweep — dist size, CHANGELOG bloat, dead script, menu surface collapse
column: planned
created: 2026-08-18T19:54:05+0200
updated: 2026-08-18T19:54:05+0200
current-owner: llm-externalizer-claude
task-type: refactor
approval-tier: 0
---

# Deadweight sweep

## WHY

Self-audit confirmed four independent weight problems
(reports/plugin-self-audit/DELEGATION.md). None is a correctness bug;
together they slow installs, bloat diffs, and pollute agent menus.

## Sub-items (each gets its own design decision inside dev)

1. **39MB dist in git.** CONSTRAINT: the plugin installs from GitHub, so
   `dist/` MUST stay tracked — deletion is off the table. Design space:
   esbuild `minify` (source stays authoritative), splitting the three
   bundles' shared vendor chunk, and dropping any bundle no entry point
   references. Decide with measurements, not taste. History rewrite is
   FORBIDDEN (RULE 0 / no force-push).
2. **CHANGELOG bloat (~15k lines).** publish.py pastes full commit
   bodies. Fix in publish.py: subject-line-only entries going forward.
   Do NOT rewrite existing entries (history).
3. **Dead `add-shebang.mjs`.** CHANGELOG:10462 cites
   `mcp-server/add-shebang.mjs` which no longer exists. Verify nothing
   references the script (grep rules/skills/commands/scripts), then
   remove it via git rm in a commit (recoverable), or repoint if a
   build step still needs it.
4. **58 menu surfaces / mass-scout collapse.** The mass-scout family is
   ~17 separate skills; evaluate collapsing into one skill with actions.
   BLOCKED-BY judgment: skill names are user-facing API — collapse needs
   a deprecation note in README + CHANGELOG, no silent removals.

## Acceptance

- [ ] Each sub-item lands as its own commit with measurements in the
      commit body (before/after size or count).
- [ ] No install/runtime regression: dogfood suite green, plugin loads,
      `llm-ext --help` intact.

## Notes and lessons learned

## Approval log
