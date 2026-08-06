---
trdd-id: K3PW7Q2M
title: Port the profile surface to the llm-ext CLI catalog
column: todo
created: 2026-08-06T17:35:00+0200
updated: 2026-08-06T17:35:00+0200
current-owner: claude-llm-externalizer
task-type: feature
priority: 3
severity: MEDIUM
effort: M
labels: [cli, profiles, migration-gap]
npt: []
eht: []
blocked-by: []
release-via: publish
target-branch: main
test-requirements: [unit, typecheck, lint]
---

# Port the `profile` surface to the `llm-ext` CLI catalog

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-06

- **Verified gap (2026-08-06):** `./bin/llm-ext --help` lists no `profile` command.
  The surface exists only in the legacy standalone CLI — `scripts/llm-ext/src/cli.ts:974`
  still names `'profile'` in its unknown-command message, and that bundle builds to
  `scripts/llm-ext/dist/cli.js`, a second entry point beside `dist/llm-ext.js`.
- **Why it matters:** the v11.0.0 MCP→CLI migration made `llm-ext` the single supported
  surface. A capability reachable only from the legacy bundle is invisible to every
  documented path (skills, slash commands, the rules file).
- **NEXT ACTION:** add a `profile` command to the `llm-ext` catalog (list / show active /
  switch), reusing the existing profile resolution in `config.ts` — no new config schema.
  Then cover it in the dogfood harness and mention it in the config skill.
- **Do NOT** re-implement profile resolution; the logic already exists and is shared.

## Acceptance

- [ ] `llm-ext profile` appears in `llm-ext --help` and works (list, show active, switch)
- [ ] unit tests + typecheck + lint clean
- [ ] dogfood harness exercises it
- [ ] config skill / README mention the command
