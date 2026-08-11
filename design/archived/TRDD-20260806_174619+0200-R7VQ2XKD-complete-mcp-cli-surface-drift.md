---
trdd-id: R7VQ2XKD
title: Complete the MCP to CLI migration — remove surface drift from commands and skills
column: completed
created: 2026-08-06T17:46:19+0200
updated: 2026-08-11T21:15:00+0200
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
- `skills/` wave — 13 files fixed, 88 invocations rewritten and each command/flag verified
  against `--help`: the three `usage-patterns.md` files, the mass-scouting skill (4 files),
  or-model-info (3 files), config, ensemble-autoselect, dogfood-test. (`b841e05`)
- `commands/` wave — 13 files fixed: the `--specs` → `--spec_file_path` rename (3 files),
  6 cost-safety additions, stale MCP wording, and removal of references to the legacy
  `npx llm-externalizer profile …` subcommands (that surface is disabled; the real gap is
  tracked by TRDD-K3PW7Q2M).

**CORRECTION — the audit's biggest finding class was WRONG (2026-08-06).** It reported ~16
CRITICAL "kebab vs snake flag mismatches" (`--db-path` documented, `--db_path` actual). Those
docs are CORRECT: `scripts/llm-ext/src/cli/main.ts:208` normalises `-`→`_` at parse time, proven
behaviourally (`mass-scout-jobs-list --db-path X` ≡ `--db_path X`, identical output). Fixing
them would have been pure churn. **Do not re-open that class.** The genuinely broken flag was
`--specs`, which is not a kebab variant of anything — it simply does not exist.

**Also verified, do not "fix":** `security-scan` deliberately REFUSES `--estimate`
("runs through the mass_scouting subsystem with its own cost controls") — `--budget_usd` is its
gate by design.

- `agents/` + `README.md` + `docs/` wave — 2 real fixes: README documented
  `mass-scout <subcommand>` (the flat `mass-scout-<subcommand>` form is the real one), and
  `docs/agent-usage-reference.md` passed the spec to `check-against-specs` via
  `--instructions_files_paths` while omitting `--spec_file_path`, which `--help` marks
  **(required)** — that documented invocation could never have run.

**RE-AUDIT PASSED (2026-08-06, re-run independently, not taken on an agent's word).** Across
`commands/ skills/ agents/ README.md docs/`: 0 retired MCP payloads · 0 `mcp__` tool ids ·
0 "MCP server" mentions · 0 legacy-binary invocations · every documented `llm-ext` command
resolves in the live catalog.

**NEXT ACTION: none — awaiting human review.** The acceptance criteria below are met. What this
card did NOT do, deliberately: the *structural* half of the migration (two runtime entry points,
one of them the published npm bin) is a breaking public-API change and is filed separately as
proposal TRDD-W9DK4L3N for the owner to rule on.

**Do NOT** "fix" a doc by deleting the example — a command with no worked example is how this
drift became invisible in the first place.

## Acceptance

- [x] zero retired MCP tool-call payloads under `commands/`, `skills/`, `agents/`, docs —
      VERIFIED 2026-08-11 by grep after the fix in `5c9d253`. NOT clean beforehand: the earlier
      "0 drift" claim was narrative, and four live sites still named MCP as the invocation path
      (`or-model-info/SKILL.md:5`, which contradicted itself 14 lines later, plus three
      `tool-reference.md` copies saying "MCP is read-only").
- [x] zero `llm-externalizer <cmd>` invocations presented as the supported surface — FIXED
      (`2ff6c56`). Five benchmark modules printed `Re-run: llm-externalizer benchmark --…`, which
      was wrong TWICE: `llm-externalizer` is not on plugin users' PATH, AND `benchmark` was never
      a verb on either CLI — the benchmarks ship as a separate `bin/llm-ext-benchmark`. Now
      corrected there and verified against that binary. Re-checked: 5 files carry the new form,
      0 carry the old.
- [x] every documented command exists in `llm-ext --help`; every documented flag exists in that
      command's own `--help` — AUDITED against the live binary. `README.md` (44 commands, 106
      flags) and `docs/`, `commands/`, `agents/` invocation examples came back VERIFIED CLEAN.
      Two skills were defective and are fixed: `or-model-info` passed the id positionally when the
      CLI takes only named flags (`f88d840`), and `free-scan` told agents to pass `--free` /
      `--output_dir` to `scan-folder`, which accepts neither (`70f17c0`).
- [x] every documented paid run shows the `--estimate` dry-run first — FIXED (`ceaad6d`). Four
      files carried paid examples with zero mention of `--estimate`;
      `docs/agent-usage-reference.md` alone had 12 across 653 lines. All four now carry the
      established preamble, conditional on a paid profile.
- [x] re-run of both audits returns 0 critical / 0 major — re-verified 2026-08-11 AFTER the
      fixes, by measurement rather than by trusting the earlier "clean" claim: 0 dead-MCP refs;
      5/5 benchmark hints corrected with 0 stale; `or-model-info` fully on `--model` with 0
      positional forms; all 4 paid-example files carrying the `--estimate` rule.

      **A LESSON THIS CARD EARNED TWICE.** Its first "0 drift" was narrative, and four live MCP
      references survived it. Then, closing it today, I re-verified four criteria, saw them green,
      and nearly archived the card while a HIGH finding on `free-scan` was still open — because I
      had fixed one of the two defective skills the audit named and carried "the skills are done"
      forward as if it covered both. A checklist re-verified item-by-item catches what a summary
      impression does not.

## Approval log

- 2026-08-11T19:30:58+0200 — `human_review` → `dev`, NOT closed. The owner approved closing it
  with "verify each before doing it"; verification failed. One of five criteria is now genuinely
  met, one is measurably unmet, three were never checked. Moved to `dev` rather than left in
  `human_review` so the board stops claiming it awaits a human when it awaits work.

- 2026-08-11T21:15:00+0200 — `dev` → `completed`, archived. All five criteria now MET and each
  re-verified by measurement after the fixes, not by re-reading the earlier claims. Fix commits:
  `5c9d253` (MCP refs), `2ff6c56` (benchmark re-run hints), `f88d840` (or-model-info invocations),
  `70f17c0` (free-scan flags), `ceaad6d` (--estimate preamble). The docs audit that found the last
  three is at `reports/session-summary-design/20260811_205455+0200-docs-vs-cli-audit.md`.
