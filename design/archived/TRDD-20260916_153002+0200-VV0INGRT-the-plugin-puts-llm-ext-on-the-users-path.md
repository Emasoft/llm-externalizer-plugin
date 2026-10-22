---
trdd-id: VV0INGRT
title: the plugin puts llm-ext on the users PATH
column: complete
created: 2026-09-16T15:30:02+0200
updated: 2026-09-23T23:39:50+0200
current-owner: agent
created-by: user
task-type: feature
min-approval-requirement: none
assignee: agent
mandate: true
mandated-by: none
approved: true
approval-judge: user
approval-datetime: 2026-09-16T15:30:02+0200
---

# the plugin puts llm-ext on the users PATH

## WHY

Outside Claude Code sessions, `llm-ext` is "command not found". Claude Code only adds the
plugin bin/ to PATH inside its own sessions; the plugin ships no install step (hooks.json
empty); package.json declares bin llm-ext / llm-externalizer but the package is not published
to npm (404). A user who wants to run llm-ext from a normal terminal, a cron job, or a
non-Claude script has no path to it.

## Evidence

- reports/llm-ext-shim/20260916_152632+0200-install-verify.md
- A hand-installed shim is in use on one machine (14/14 PASS verification in the report
  above). Its logic: (1) if PATH already has a
  */plugins/cache/*/llm-externalizer/*/bin match, exec that CLI; if it is present but not
  runnable, exit 1 with a clear message. (2) Otherwise read
  ${CLAUDE_CONFIG_DIR:-~/.claude}/plugins/installed_plugins.json, require exactly one
  user-scope llm-externalizer@* record, exec <installPath>/bin/llm-ext. No fallback beyond
  that. Exit 127 if node is missing.
- The shipped `use-llm-externalizer` rule's example `llm-ext llm ask ./prompt.md` fails with
  "Either instructions or instructions_files_paths must be provided" -- the example passes a
  positional argument that the CLI reads as an input file, not as the instructions text.

## Acceptance criteria

1. The plugin installs or refreshes an on-PATH shim itself (for example from a SessionStart
   hook, or the setup skill) into a user bin dir on PATH, without overwriting a foreign file
   that is not its own shim.
2. Ship the shim plus its tests (the two-step resolution logic: session plugin bin dir first,
   then the installed_plugins.json registry lookup, matching the verified design in the
   evidence report).
3. Fix the `use-llm-externalizer` rule's broken example so `llm-ext llm ask ./prompt.md`
   (or its corrected form) actually runs without the "instructions" error.

## Verification

Real tests (no mocks of the code under test) for the shim's install/refresh logic and its
PATH-resolution branches. Suite and tsc green where applicable; shellcheck clean for the shim
script itself.

## Approval log

- 2026-09-16T15:30:02+0200 — MANDATE issued by user (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-09-23T23:39:50+0200 — COMPLETE by agent. archived → complete.

## STATE

2026-09-16 T3 impl complete: scripts/path-shim/llm-ext + scripts/hooks/install-path-shim.sh created (cmp-verified, mode 0755); hooks/hooks.json wired (jq -e exit 0); src/path-shim.test.ts (24 tests, I1-I14+W1-W10) added to vitest include list — isolated run 24/24 passed, exit 0; tsc --noEmit exit 0 (0 errors in path-shim.test.ts); shellcheck -s sh exit 0 both scripts; README.md Global llm-ext command section added; TRDD-CCS6ENHU filed for the pytest-not-in-CI gap. THIS MACHINE: ~/.local/bin/llm-ext installed, real hook run exit 0/empty stdout/bytes+inode unchanged, fresh zsh -lic 'llm-ext --version' -> 13.6.0 exit 0. Column -> testing.

## Fresh check evidence

Fresh check 2026-09-23: scripts/llm-ext/vitest.config.ts:516 includes 'src/path-shim.test.ts'; scripts/path-shim/llm-ext and scripts/hooks/install-path-shim.sh exist (mode 0755); hooks/hooks.json:9 wires install-path-shim.sh into SessionStart. reports/llm-ext-release-1410/20260923_232257+0200-baseline-measure.md line 18-19,25: full vitest suite (including path-shim.test.ts) 188 files / 2916 tests passed, 0 failed, green on HEAD. rules/use-llm-externalizer.md:5 example now reads 'llm-ext llm ask ./src/api.ts -o ./out --instructions "explain this file"' with the --instructions requirement noted; the installed copy ~/.claude/rules/use-llm-externalizer.md matches. All three ACs hold — closing.

## Acceptance checklist

- [x] AC1: plugin installs/refreshes an on-PATH shim via SessionStart hook (hooks/hooks.json:9 -> scripts/hooks/install-path-shim.sh)
- [x] AC2: shim + tests shipped (scripts/path-shim/llm-ext, scripts/llm-ext/vitest.config.ts:516 includes src/path-shim.test.ts, green in the 2026-09-23 baseline)
- [x] AC3: use-llm-externalizer rule example fixed (rules/use-llm-externalizer.md:5 uses --instructions, matches installed copy)
