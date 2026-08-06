---
trdd-id: R7VQ2XKD
title: Complete the MCP to CLI migration — remove surface drift from commands and skills
column: dev
created: 2026-08-06T17:46:19+0200
updated: 2026-08-06T17:46:19+0200
current-owner: claude-llm-externalizer
assignee: claude-llm-externalizer
priority: 2
severity: HIGH
effort: L
labels: [migration, cli, skills, commands, docs]
task-type: docs
parent-trdd: null
npt: []
eht: []
blocked-by: []
release-via: publish
delivery: direct-push
target-branch: main
test-requirements: [lint]
review-requirements: [human-review]
impacts: [public-api]
implementation-commits: []
---

# Complete the MCP → CLI migration — surface drift in commands and skills

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative) — 2026-08-06

**Why this exists.** v11.0.0 (`d557c68`) retired the MCP server and made `llm-ext` the only
runtime surface. The *code* migrated; a large part of the *documented* surface did not. An
agent that follows a stale skill or command file today executes something that cannot work —
which is worse than a missing doc, because it looks authoritative.

**Audit results (2026-08-06, evidence in `reports/mcp-cli-gap-audit/`, gitignored):**

| surface | files with findings | findings | critical |
|---|---|---|---|
| `skills/` + `agents/` + docs | 11 | 22 | 7 |
| `commands/` | 39 | 45 | 20 |

**Drift categories found (all verified against `./bin/llm-ext --help`, not assumed):**
1. Examples still written as retired MCP tool-call JSON payloads (`{"tool": "scan_folder", …}`).
2. Wrong binary name — `llm-externalizer <cmd>` instead of `llm-ext <cmd>`. That name belongs to
   the legacy standalone bundle (`scripts/llm-ext/dist/cli.js`), a second entry point that still
   exists and is NOT the supported surface.
3. Wrong command shape — `mass-scout build-fieldset` (two words) instead of the real flat
   `mass-scout-build-fieldset`.
4. Flags documented that the command does not have.
5. Paid runs documented without an `--estimate` dry-run first (violates the project cost rule).
6. Retired "three surfaces" (MCP + CLI + slash) parity claims; it is CLI + skills now.

**DONE so far (this session):**
- `skills/` wave 1 — 13 files fixed, 88 invocations rewritten and each command/flag verified
  against `--help`: the three `usage-patterns.md` files, the mass-scouting skill (4 files),
  or-model-info (3 files), config, ensemble-autoselect, dogfood-test.

**NEXT ACTION:** the `commands/` wave — 39 files, 45 findings, 20 critical. Same method: read
the finding, verify against `./bin/llm-ext <cmd> --help`, fix with the Edit tool, never invent a
flag. Then re-run the two audits and confirm the counts go to zero.

**Do NOT** "fix" a doc by deleting the example — a command with no worked example is how this
drift became invisible in the first place.

## Acceptance

- [ ] zero retired MCP tool-call payloads under `commands/`, `skills/`, `agents/`, docs
- [ ] zero `llm-externalizer <cmd>` invocations presented as the supported surface
- [ ] every documented command exists in `llm-ext --help`; every documented flag exists in that
      command's own `--help`
- [ ] every documented paid run shows the `--estimate` dry-run first
- [ ] re-run of both audits returns 0 critical / 0 major
