---
trdd-id: WIO13P1P
title: Deadweight sweep — dist size, CHANGELOG bloat, dead script, menu surface collapse
column: dev
created: 2026-08-18T19:54:05+0200
updated: 2026-08-19T00:35:00+0200
current-owner: llm-externalizer-claude
task-type: refactor
approval-tier: 0
---

# Deadweight sweep

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-19

Measurements, all first-hand verified 2026-08-19 (post v13.5.8):

1. **dist 39M** = `scripts/llm-ext/dist/`: index.js 14,784,046 B +
   llm-ext.js 14,873,439 B + benchmark.js 10,730,287 B, all git-tracked.
   `dist/index.js` is DROPPABLE: the esbuild.config.mjs comment keeping it
   ("publish.py's release check asserts this artifact") is STALE —
   publish.py:935-948 already asserts `dist/llm-ext.js`; the CLI bundle is
   self-contained (bundles the engine from src, hence the twins); runtime
   path is `bin/llm-ext → launcher.mjs → dist/llm-ext.js`; only
   `scripts/llm-ext/package.json "main"` still points at index.js (repoint
   to dist/llm-ext.js). Expected: −14.78M (−38%).
2. **CHANGELOG 15,485 lines / 764K.** publish.py runs `git-cliff --tag X
   --output CHANGELOG.md` = FULL-HISTORY regen each publish — measured
   **~16 minutes** during the v13.5.8 publish. Fix: `--unreleased
   --prepend` + subject-only template line in cliff.toml (first line of
   `commit.message`); past entries stay verbatim, new ones one-line,
   regen time drops to seconds.
3. **add-shebang.mjs**: tracked at `scripts/llm-ext/add-shebang.mjs`,
   zero live refs (grep: only CHANGELOG + this card cite it) → `git rm`.
4. **Menu collapse**: 16 `commands/llm-externalizer-mass-scout*.md`
   files, 1,101 lines total, each a thin doc wrapper over
   `bin/llm-ext mass-scout-* …`; skill
   `llm-externalizer-mass-scouting` (97 lines) already covers the
   family. Collapse ⇒ 40→25 commands; user-facing removals need
   deprecation notes (README + CHANGELOG).

DONE 2026-08-19: sub-item 3 → 3ab7cc4 (20 lines), sub-item 1 → fedacf5
(dist 40,387,772→25,603,726 B, −36.6%; rebuild deterministic; `--help` +
`--version` green), sub-item 2 → 2c4138d (prepend + subject-only,
verified on a copy: +16 lines, past entries byte-untouched). Dogfood
after all three: **119 PASS / 0 FAIL / 1 SKIP**.

NEXT ACTION: sub-item 4 — collapse the 16 mass-scout command files into
one dispatcher command (+ deprecation notes in README + CHANGELOG),
then close the card. Sub-item 2's real-world proof = next publish run
(watch step 4 duration + prepended section).

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
- [x] No install/runtime regression: dogfood suite green (119/0 post
      sub-items 1+2+3), plugin loads, `llm-ext --help` intact.

## Notes and lessons learned

## Approval log
