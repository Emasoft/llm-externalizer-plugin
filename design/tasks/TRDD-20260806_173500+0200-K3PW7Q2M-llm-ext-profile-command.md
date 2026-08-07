---
trdd-id: K3PW7Q2M
title: Port the profile surface to the llm-ext CLI catalog
column: human_review
created: 2026-08-06T17:35:00+0200
updated: 2026-08-07T12:10:00+0200
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

## DONE 2026-08-07 — shipped READ-ONLY, deliberately

`profile` lists every profile in `settings.yaml` (starring the active one) and
`--show <name>` prints one resolved in full.

**`switch` was NOT implemented, and that is the decision, not an omission.** Configuration in
this project is user-only — `settings.yaml` is hand-edited and there is deliberately no
`set-settings` / `change-model` command. A `profile --switch` would be the same write surface
under a different name, so it would contradict a standing design rule to satisfy one acceptance
box. The box is amended below rather than silently ticked.

Verified by re-running, not by report: `llm-ext --help` lists `profile`; `./bin/llm-ext profile`
runs and prints all 5 profiles with the active one starred; full suite 1775 passed / 0 failed;
`tsc --noEmit` and lint both exit 0.

Side note surfaced by the live run: the active profile is named `remote-ensemble-geminigrok` but
resolves to three deepseek models — a stale NAME, already recorded in the archived rescan card.
Cosmetic; not fixed here because renaming a profile edits the user's settings.

## Acceptance

- [x] `llm-ext profile` appears in `llm-ext --help` and works (list + `--show <name>`)
- [x] ~~switch~~ — amended: out of scope, contradicts the user-only-configuration rule (see above)
- [x] unit tests + typecheck + lint clean
- [x] README mentions the command (and its command-count guard updated: 42→43, 19→20 core)
- [ ] dogfood harness exercises it — pending; the harness validates surfaces generically today
