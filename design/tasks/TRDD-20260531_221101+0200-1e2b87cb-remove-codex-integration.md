---
trdd-id: 1e2b87cb-9b3e-4031-a1c7-7cc7bde54ac7
title: Remove the Codex externalization integration entirely — Codex breaks all Claude Code plugins
status: completed
created: 2026-05-31T22:11:01+0200
updated: 2026-05-31T23:12:33+0200
---

# TRDD-1e2b87cb — Remove the Codex externalization integration entirely

**Filename:** `design/tasks/TRDD-20260531_221101+0200-1e2b87cb-remove-codex-integration.md`
**Tracked in:** `Emasoft/llm-externalizer-plugin` (this repo)

## User directive (verbatim, 2026-05-31)

> "remove the integration of the skill to use codex, since every time claude
> call codex it breaks all claude plugins."
> "make sure codex is never called or used from claude code."

Explicit, authorized destructive change (clear written approval — satisfies
RULE 0's "receive clear written approval before any deletion").

## Why (the actual threat — corrected)

Calling the `codex` CLI from inside Claude Code **breaks every other Claude Code
plugin**: codex overwrites/clobbers the `CLAUDE_PLUGIN_DATA` environment variable
with a codex folder, so any plugin that resolves its data dir via
`CLAUDE_PLUGIN_DATA` (see
https://code.claude.com/docs/en/plugins-reference#environment-variables) reads
the wrong path after codex has run. Verified-on-disk aggravating factors in this
plugin's runner (`scripts/codex/run-codex-scan.py`):
- line 276: invokes `codex --dangerously-bypass-approvals-and-sandbox exec …`
  — the NO-sandbox / NO-approval mode (full FS + network).
- lines 109-127 / 448: `ensure_codex_multi_agent_config()` WRITES the user's
  global `~/.codex/config.toml` on every run — global side effect outside the
  project.

Decision: **remove the integration outright** (option C from the superseded
triage TRDD-8de4e9f2). Not harden, not gate — REMOVE, and guarantee codex is
never invoked from this plugin again.

## Blast radius (verified via `git grep -il codex`)

**Feature files to DELETE (all git-tracked → recoverable from history):**
1. `commands/llm-externalizer-codex-scan.md`  (slash command)
2. `skills/llm-externalizer-codex-scan/SKILL.md` (+ the skill dir)
3. `scripts/codex/run-codex-scan.py`  (the runner — the thing that calls codex)
4. `scripts/codex/codex-scan-prompt.txt`
5. `scripts/codex/codex-scan-prompts.md`  (→ remove the whole `scripts/codex/` dir)
6. `tests/test_run_codex_scan.py`

**Reference cleanups (edit, don't delete):**
- `tests/conftest.py:11` — drop `"codex"` from the sys.path subdir tuple.
- `tests/test_fix_found_bugs_helper.py:16` — comment mentions
  `tests/test_run_codex_scan.py`; reword so it doesn't reference a deleted file.
- `tests/dogfood/dogfood_test.py:652,678` — comments cite codex as a slash-only
  example; drop the codex mention (and any codex skill/command row the harness
  enumerates dynamically — verify the structural audit still passes once the
  files are gone).
- `README.md` — remove codex-scan from command lists + any prose; fix the
  command/skill COUNTS (36 commands → 35, 16 skills → 15) and the
  doc-consistency-tracked headings. `doc-consistency.test.ts` will FAIL until
  counts match — that's the gate that proves the cleanup is complete.
- `CHANGELOG.md` — git-cliff regenerates from commit messages on publish; add a
  removal entry via the commit message rather than hand-editing.
- `docs/openrouter/responses-api.md` — remove/adjust the codex reference.

**Verify NO residual invocation anywhere:**
- `grep -rn "codex" mcp-server/src bin` must return ZERO (the MCP server / bins
  must never spawn codex). Confirmed clean in pre-removal scan, re-verify after.
- No `bin/` entry, no `.mcp.json`, no hook, no other script may shell out to
  `codex`.

## Guarantee: codex is never called from Claude Code (belt + suspenders)

1. Delete the only caller (`run-codex-scan.py`) and its command/skill surfaces.
2. After removal, assert `git grep -n "\bcodex\b"` across the SHIPPED tree
   (commands/ skills/ scripts/ mcp-server/src bin .mcp.json hooks) returns
   nothing that invokes codex (doc/test prose that merely says "do not use
   codex" is fine).
3. Add a dogfood/CI guard: a test that FAILS if any shipped file contains a
   `codex exec` / `subprocess … codex` invocation, so it can never be
   reintroduced silently.

## Acceptance criteria

- [ ] All 6 feature files deleted; `scripts/codex/` and
      `skills/llm-externalizer-codex-scan/` dirs gone.
- [ ] conftest / test / dogfood / README / docs references cleaned; no dangling
      refs to deleted files.
- [ ] README command count 36→35 and skill count 16→15 (and the dogfood `dist`/
      structural audit) consistent; `doc-consistency.test.ts` green.
- [ ] `git grep` proves zero codex INVOCATION remains in the shipped tree.
- [ ] A guard test prevents reintroduction.
- [ ] `npm run build` + `npm run lint` + full vitest + `uv run` python tests +
      `uv run tests/dogfood/dogfood_test.py` all green.
- [ ] TRDD-807c1e2d (original codex design) + TRDD-8de4e9f2 (triage) marked
      superseded by this TRDD.
- [ ] No push without explicit user go (standing rule).

## Supersedes / related

- Supersedes `TRDD-8de4e9f2` (triage — had the threat mechanism WRONG: it said
  default sandbox was read-only; the runner actually uses
  `--dangerously-bypass-approvals-and-sandbox`).
- Supersedes `TRDD-807c1e2d` (the original codex-gpt55-scan integration design).

## Status log

- 2026-05-31 22:11 — Authoritative removal TRDD authored on explicit user order.
  Blast radius mapped (6 feature files, 6 referencing files), all targets
  git-tracked + recoverable. Removal to be done by a focused agent, diff
  reviewed + committed by the orchestrator. No push.
- 2026-05-31 23:12 — **COMPLETE.** 6 feature files git-rm'd
  (commands/llm-externalizer-codex-scan.md, skills/llm-externalizer-codex-scan/,
  scripts/codex/{run-codex-scan.py,codex-scan-prompt.txt,codex-scan-prompts.md},
  tests/test_run_codex_scan.py); empty scripts/codex/ dir removed. References
  cleaned: conftest.py (dropped "codex" subdir), test_fix_found_bugs_helper.py
  (comment), dogfood_test.py (comments), README.md (removed command section +
  table row + base-command inline mention; counts 36→35 commands, 19→18 base,
  16→15 skills, tree comments 36→35 / 16→15), docs/openrouter/responses-api.md
  (gpt-5.3-codex MODEL-name mentions left — OpenAI Responses-API model, not the
  codex CLI). Added guard test mcp-server/src/no-codex-invocation.test.ts (wired
  into vitest include) that fails if any shipped file reintroduces a codex
  invocation (/codex exec/, /--dangerously-bypass.../, /subprocess.*codex/,
  /shutil.which("codex")/); prose excluded. The orchestrator's first agent
  corrupted README; orchestrator reverted README to HEAD and re-did the edits
  cleanly + independently verified. GATES (verified): npm build 0, lint 0, vitest
  990 passed/4 skipped (doc-consistency green), pytest 116 passed, dogfood exit 0
  (96 PASS/0 FAIL/1 skip, 35 cmds + 15 skills). `git grep` for codex INVOCATION
  over commands/scripts/skills/mcp-server-src/bin = EMPTY. Codex can no longer be
  called from Claude Code via this plugin. No push.
