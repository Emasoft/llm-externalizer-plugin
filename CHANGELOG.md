# Changelog

All notable changes to this project will be documented in this file.
## [9.0.7] - 2026-04-22

### Changed

- Build: rebuild dist after index.ts sanitize/retry/imports fixes


### Fixed

- Fix: real bugs from verified CANTFIX re-audit + WIP hardening

Re-verified all 34 fixer reports from 2026-04-17 against current code.
Of the 10 CANTFIX items, 3 were confirmed as real unfixed bugs; the rest
were false positives, intentional design, or already fixed by other commits.

Real bugs fixed:
- bin/llm-ext: Add killAndExit() helper (SIGTERM→SIGKILL ladder,
  2s grace). Replaces 7 race-prone 'child.kill(); process.exit(X)'
  call sites that could leave orphan MCP server processes under
  init/systemd when the parent exited before SIGTERM was delivered.
- live-websearch.test.ts: Add module-level afterAll() that removes
  both /tmp/__llm_ext_websearch_test and _test_config — the per-suite
  afterAll hooks only closed transports.
- live-extended.test.ts: Document the 'if (!result.isError)' guard
  on the check_references test (same tolerance pattern as check_imports,
  just missing the explanatory comment).

WIP hardening (was uncommitted from earlier sessions):
- index.ts: sanitizeInputPath() traversal+symlink protection in
  scan_folder / compare_files / search_existing_implementations;
  circuit-breaker+retry in grouped batch_check (parity with the
  non-grouped branch); gitLsFilesMultiRepo returns null when target
  is NOT itself a git repo (prevents silently dropping non-git files
  in mixed trees); extractLocalImports handles Python __init__.py
  package entry points; chatCompletionJSON strips markdown fences
  before JSON.parse (some providers wrap JSON even under
  response_format: json_schema).
- .githooks/pre-push: Tighten publish.py regex with a (?=\s|$)
  lookahead so 'publish.py.bak' / 'publish.pyc' substrings cannot
  bypass ancestry matching.
- statusline.py: TOCTOU-safe /tmp/claude cache: lstat refuses
  symlinks, O_NOFOLLOW + fchmod instead of chmod (CWE-59).
- test-helpers.ts: Drain server stderr via transport.stderr?.pipe
  to prevent PassThrough buffer from filling and hanging tests.
- check_references.py: Strip URL fragments from ${CLAUDE_PLUGIN_ROOT}
  matches; skip absolute '/'-prefixed markdown links; move
  _is_excluded check BEFORE existence checks.
- publish.py: Docstring now matches implementation (no-op fallback
  removed — step 6 fails fast).
- server.json: Drop legacy LM_STUDIO_PASSWORD mention from description.

Verification: tsc --noEmit clean, eslint --max-warnings 0 clean,
ruff+mypy on all .py files clean, 82 vitest unit tests pass (index +
grouping), bin/llm-ext discover E2E exits 0 with no orphans.


## [9.0.6] - 2026-04-21

### Fixed

- Fix(readme): restore BADGES markers; publish.py emits centered HTML form

The full README rewrite dropped the <!--BADGES-START--> / <!--BADGES-END-->
comment markers that publish.py's update_readme_badges() function needs
to auto-refresh the version/build shields on each release. Without them
the badges went stale (still read v9.0.1 after v9.0.5 shipped).

Fix:
- README.md: wrap the existing centered <p align="center">…</p> badge
  block with the two HTML-comment markers + bump the version shield to
  the current v9.0.5.
- scripts/publish.py: update_readme_badges() now emits the same
  <p align="center"> wrapper with one <a><img></a> per badge so the
  visual layout does not regress when publish regenerates the block.

CPV result after this change: 0 CRITICAL / 0 MAJOR / 0 MINOR / 0 NIT,
1 WARNING (transient "dead URL" on github.com/Emasoft/emasoft-plugins
which curl confirms returns 200 — false positive from the validator).


### Miscellaneous

- Chore(versioning): align pyproject.toml with plugin version and sync it via publish.py

Before this commit the repo had three version numbers that disagreed:
- .claude-plugin/plugin.json      → 9.0.5
- mcp-server/package.json         → 9.0.5
- pyproject.toml                  → 4.1.5   ← drift

publish.py only synced plugin.json, mcp-server/package.json,
mcp-server/server.json, and mcp-server/src/index.ts. pyproject.toml
(and its uv.lock) were never touched, so every release they drifted
further behind.

This commit:
- Sets pyproject.toml to 9.0.5 (current plugin version).
- Regenerates uv.lock so its root-package entry matches.
- Teaches publish.py to sync pyproject.toml on every release, then
  run `uv lock` to keep uv.lock consistent, then stage both files
  alongside the existing release artifacts.

After this, every future release will carry one version across all
four files. No more "which number is real?".


## [9.0.5] - 2026-04-21

### Added

- Feat(format): canonical <ts±tz>-<slug>.<ext> for every report file

Every surface the plugin ships now writes to the same filename shape
defined by ~/.claude/rules/agent-reports-location.md — no carve-outs.

Timestamp: %Y%m%d_%H%M%S%z (local time with GMT offset appended as
compact ±HHMM — filesystem-safe on every OS, sortable by ls -t). Never
UTC, never ±HH:MM.

- mcp-server/src/index.ts:
  - new canonicalTimestamp() helper (local time + compact offset).
  - saveResponse() emits <ts±tz>-<tool>[-group-<id>][-<src>]-<shortId>.md
    instead of the old <tool>_<src>_<isoZ>_<shortId>.md.
  - batchReportFilename() follows the same shape.

- scripts/fix_found_bugs_helper.py:
  - TS_FORMAT switched from "%Y%m%dT%H%M%S%z" (ISO "T") to the canonical
    "%Y%m%d_%H%M%S%z" (underscore).
  - init-run prints paths like <ts>-fix-found-bugs-<purpose>.<ext>
    instead of the legacy dot-separated <ts>.fix-found-bugs.<purpose>.<ext>.
  - SIDECAR_MARKERS recognises both the legacy dot-shape and the new
    hyphen-shape so artefacts from either generation are skipped during
    aggregation.

- mcp-server/dist/index.js: rebuilt to match source.

- Feat(commands): worktree-safe MAIN_ROOT for reports — no carve-outs

Every LLM Externalizer command now resolves the main-repo root via
`git worktree list | head -n1 | awk '{print $1}'` and writes reports
under `$MAIN_ROOT/reports/llm-externalizer/` — the same convention as
every other agent / skill / tool in the project. $CLAUDE_PROJECT_DIR
points to whatever checkout the session is attached to (including a
linked worktree), which would scatter audit output across short-lived
branches. The main checkout is always listed first by `git worktree
list`, so it's a safe canonical target regardless of where the command
runs from.

- commands/llm-externalizer-scan-and-fix.md
- commands/llm-externalizer-scan-and-fix-serially.md
- commands/llm-externalizer-fix-found-bugs.md
- commands/llm-externalizer-fix-report.md

Each command now carries a short worktree-safe prologue that the
orchestrator must reproduce at the top of every Bash step (the tool
spawns a fresh subshell per call, so env vars don't persist between
steps). Every JSON-template reference to output_dir uses
<MAIN_ROOT>/reports/llm-externalizer. Falls back to $CLAUDE_PROJECT_DIR
only when we're not inside a git working tree (e.g. sandbox runs).

This matches the agent-reports-location rule verbatim: same rule,
same folder, for everything — even the externalized LLM.


## [9.0.4] - 2026-04-20

### Changed

- Revert(publish): drop reports/ → reports_dev/ move step; gitignore reports/

Simpler rule wins: the ./reports/ tree is always audit output, always
private, and always gitignored. Agents — including those running from
inside a git worktree — must write to the root-project ./reports/
folder so the maintainer retains a single place to find audit output.
No intermediate relocation needed.

- .gitignore: add ./reports/ (and ./mcp-server/reports/) back to the
  ignore list with a comment stating the agent-behavior rule.
- scripts/publish.py: remove archive_reports_to_dev() and the Step 0
  invocation + docstring entry. CPV no longer needs to re-scan the
  tree because gitignored paths are already outside its scope.


## [9.0.3] - 2026-04-20

### Added

- Feat(publish): archive ./reports/ into ./reports_dev/ before validation

Rationale: the ./reports/ tree is where agents and workflow runs drop
audit output. Those files carry absolute local paths (/Users/<user>/...),
redacted secret markers, and raw LLM output — none of which should ever
land in a published plugin or in CPV's "private path leaked" scan.

The prior fix (gitignoring ./reports/) worked but threw away the audit
data when the workflow branch was merged or deleted, and it split the
convention (reports_dev/ gitignored but reports/ gitignored too is
confusing when agents spawned in workflows need the data back).

New design:
- Revert the ./reports/ gitignore — the tree is untracked only because
  no agent commits it, not because it's hidden from scanners.
- Step 0 of publish.py (before pre-flight): move every file under
  ./reports/ and ./mcp-server/reports/ into
  ./reports_dev/reports-archive/<UTC-timestamp>/ with the subtree
  preserved. reports_dev/ is already gitignored, so the data survives
  but never reaches CPV, the published tarball, or the marketplace.
- Idempotent: each run creates a fresh timestamped folder, so repeated
  publishes never overwrite prior snapshots. Workflows that merge and
  delete branches keep their audit trail in reports_dev/ on the
  maintainer's machine.


### Refactored

- Refactor(publish): 1:1 mapping reports/ -> reports_dev/ (no timestamped subfolder)

Rationale: timestamped archive folders were the wrong abstraction.
Users locate a moved file by simply replacing `reports` with
`reports_dev` in its path — anything more elaborate breaks that
intuition and forces grep-by-timestamp to find old output.

New behavior: a file at `reports/llm-externalizer/foo.md` lands at
`reports_dev/llm-externalizer/foo.md` exactly. Sub-tree preserved.
Collisions overwrite (newer publish run wins — matches the "latest
audit output" expectation for workflow agents). Same pairing applies
to mcp-server/reports/ -> mcp-server/reports_dev/.


## [9.0.2] - 2026-04-20

### Added

- Feat(format): sentinel [[FINDING]] blocks replace ### FINDING headings

Why: the old ### FINDING: scan format collides with the aggregator's
own ### N. FINDING: output numbering and with ensemble-wrapper ## Model:
sections. When the aggregator embedded an ensemble response into a
finding body, the nested ### headings in that body got re-parsed as
separate findings, swallowing all subsequent bugs in the list.

The new format uses markdown-immune sentinels:

  [[FINDING]]
  Title: <short title>
  File: <abs path>
  Source: <function or file:line>
  Severity: <High|Medium|Low>
  Description: <1-3 sentences>
  [[/FINDING]]

- commands/llm-externalizer-scan-and-fix{,-serially}.md: default
  rubric now instructs models to emit sentinel blocks; explicit
  warning not to use ### or numbered-list syntax.

- scripts/fix_found_bugs_helper.py: new FINDING_BLOCK_RE recognises
  the sentinel, _parse_finding_block parses the Key: value fields,
  and _extract_findings_from_section prefers the new format and
  falls back to the legacy ### / numbered-list patterns only when
  no sentinel blocks are found in the section. Mixing formats in
  one section is explicitly not allowed.

- Feat: strengthen fixer verification + emit canonical scan findings

- agents/llm-externalizer-{parallel,serial}-fixer-{sonnet,opus}-agent.md:
  lead with a MANDATORY VERIFY BEFORE FIXING callout listing the
  5 false-positive rejection rules (hallucination, flow-trace,
  already-fixed, style preference, redaction artifact). A no-edit
  "false-positive" verdict is explicitly marked as a successful
  outcome to discourage speculative fixes. Empirically ~15-30% of
  ensemble findings are false positives; the fixer now rejects them
  with typed reasons.

- commands/llm-externalizer-scan-and-fix{,-serially}.md: default scan
  rubric now requires canonical "### FINDING: <title>" / Source /
  Severity / body format so fix_found_bugs_helper.py aggregate-reports
  can parse findings without a format-massaging pass. Explicit
  instruction to ignore [REDACTED:ENV_SECRET]/[REDACTED:API_KEY]
  placeholders and to emit "No real defects." when clean.


### Changed

- Build: rebuild dist after rescan-audit fixes

- Build: rebuild dist after 40-file source audit fixes


### Documentation

- Docs: full README rewrite + LLM-Externalizer banner

- Add docs/banner.png (plugin banner/logo at top of README).
- Rewrite README with a plain-language intro making the scan-vs-fix
  split explicit: only the SCAN is externalized; FIXES are applied
  by the local Claude Code session (Sonnet/Opus) via fixer subagents.
- Fix feature list and counts (15 MCP tools, 5 agents).
- Separate "Plugin commands" (/llm-externalizer:*) from "MCP tools"
  (direct mcp__plugin_* calls) so advanced users see each surface clearly.
- Every shell command now lives in its own pasteable code block, one
  logical task per block, with # comments.
- Windows variants added for env-var setup (PowerShell + cmd.exe) and
  for paths (%USERPROFILE%\.llm-externalizer\ alongside ~/.llm-externalizer).
- Configuration option B renamed from "single model" to "Remote free
  (Nemotron)" — users pick between the paid ensemble or the free
  Nemotron; no paid-single-model profile by default.
- Contributing section rewritten: contributors never run publish.py
  (owner-only); documents how to disable the pre-push hook
  (git config --local --unset core.hooksPath) and how to disable the
  owner-only workflows on a fork (gh workflow disable "Notify Marketplace"
  and "CI").


### Fixed

- Fix(grouping): preserve pre/post-group ungrouped order in parseFileGroups

The prior rescan fix (rescan #17) collected ALL ungrouped files into a
single trailing group at the end, which violated the documented
insertion-order contract and broke the "collects files outside any
markers into an unnamed group" test. That test expects three groups
in order: pre-group unnamed, named, post-group unnamed.

Fix: flush the pending-ungrouped buffer each time a new named-group
header is encountered (so the pre-group chunk lands before the named
group), and again at end-of-input (so the post-group chunk lands
after). This preserves ordering while still merging consecutive
ungrouped files into a single group.

All 31 grouping tests now pass.

- Fix(lint): prefer-const on ungrouped in parseFileGroups + rebuild dist

- Fix: rescan-audit fixes (27 real defects across 10 files)

Second-pass audit against the fixed codebase found 26 new real defects
(and a further 70 false-positives correctly rejected by the hardened
fixer's verify-before-editing rules). Highlights:

- .githooks/pre-push: argv chunk parsing no longer swallows trailing
  args; publish.py ancestry check rejects dummy scripts with crafted
  argv that embedded "publish.py" as a literal argument.
- bin/llm-ext: exit/stdout race fixed — crash detection moved to
  stdout.on("end") so valid late responses are no longer discarded
  when the child exits immediately after writing.
- mcp-server/src/config.ts: resolveProfile logic for local authentication.
- mcp-server/src/grouping.ts: duplicate-group-id handling and the
  single-unnamed-group contract in parseFileGroups; suffix-match
  disambiguation in per-file section assignment.
- mcp-server/src/index.ts: symlink traversal no longer creates
  directories outside guarded paths; check_imports path traversal
  hardened; temporary-stats file permissions tightened.
- mcp-server/src/live{,-extended}.test.ts: shared tmp-dir lifecycle
  fixed (per-test TMP_DIR, afterAll cleanup on creation failure,
  scan_secrets assertion robust against structured-error responses).
- mcp-server/statusline.py: (no new changes in this pass — Pyright
  warnings at lines 122/284 are platform-check false positives on
  sys.platform == "win32", not real bugs).
- scripts/check_references.py: markdown regex handles relative
  links; exclusion check applied to resolved targets.
- scripts/publish.py: rollback handles incomplete pushes; duplicate
  version-bump guard in determine_next_version; temporary directory
  created with 0o700 perms on POSIX.

- Fix: real defects from 126-finding scan-and-fix-serially audit

Applies fixes verified by the serial-fixer subagents (Sonnet, MANDATORY
verify-before-fixing rules). Every change was re-read against source
before editing; ~86 of the 126 findings were rejected as false positives.

Confirmed real fixes:
- .githooks/pre-push: walk_ancestry no longer splits paths on spaces,
  and ps_query decodes non-UTF8 bytes with errors="replace".
- bin/llm-ext: malformed/null tool results don't hang; final JSON-RPC
  flushed on stdout close; handleMessage exits non-zero when the tool
  reports an error (was always 0).
- mcp-server/add-shebang.mjs: guard prevents appending a second shebang
  to files that already start with "#!".
- mcp-server/esbuild.config.mjs: __filename/__dirname now defined in
  the bundled banner so CommonJS deps don't ReferenceError at runtime.
- mcp-server/server.json: numeric userConfig fields use "format": "number"
  instead of "string".
- mcp-server/src/cli.ts: parseSearchExistingArgs no longer misparses flags
  without values or accepts directories as source files; cmdSearchExisting
  honors --timeout-hours 0 as "no timeout"; git-diff rejects absolute paths
  outside the worktree.
- mcp-server/src/config.ts: getConfigDir resolves /tmp + homedir via
  realpathSync before path comparison (fixes macOS /private/tmp + Windows
  /tmp rejection false positives).
- mcp-server/src/grouping.ts: splitPerFileSections regex fixes.
- mcp-server/src/index.ts: extractLocalImports correctly resolves Python
  relative imports; gitLsFilesMultiRepo no longer double-scans submodules;
  check_against_specs honors answer_mode=0; tool descriptions no longer
  claim "parallel" for sequential local-mode calls.
- mcp-server/src/or-model-info.ts: fetchOpenRouterModelInfo handles
  payloads missing "endpoints" key; percentile labels corrected.
- mcp-server/src/test-helpers.ts: test output dirs use testName to avoid
  collisions; client timeout override now effective.
- mcp-server/src/live*.test.ts: getText guards undefined content; cleanDir
  no longer deletes LLM_OUTPUT_DIR mid-run; rmSync failures surface.
- mcp-server/statusline.py: TypeError guard on null JSON tokens.
- scripts/check_references.py: markdown regex strips anchors/queries;
  exclusion checks now applied to resolved targets; title links match.
- scripts/fix_found_bugs_helper.py: cmd_aggregate_reports guards missing
  args; _find_report_files case-insensitive prefix skip; cmd_diff_fixed
  correct unfixed_remaining count; cmd_is_canonical accepts severity
  words in finding titles.
- scripts/install_statusline.py: handles non-dict settings.json; paths
  properly escaped.
- scripts/join_fixer_reports.py: _find_candidates recursive.
- scripts/publish.py: _run_publish regex accepts single AND double quotes.
- scripts/validate_fixer_summary.py: handles unresolvable reports_dir.
- scripts/validate_report.py: _LINE_RANGE_RE matches L12-L40 / lines 12-40
  / :12-40 / 12-40 formats; BOM handled.


### Miscellaneous

- Chore(gitignore): exclude reports/ (local audit output, contains private paths)


## [9.0.1] - 2026-04-18

### Changed

- Build: rebuild dist after redact_secrets fix


### Fixed

- Fix(mcp): honor redact_secrets:true to skip the scan_secrets abort

The v9.0.0 commit set up the slash commands to send both scan_secrets:
true AND redact_secrets: true on every fix run, with a contract that
read like this in the README and in the doc comment in mcp-server/
src/index.ts:

  scan_secrets=true   + redact_secrets=false → detect, abort
  scan_secrets=true   + redact_secrets=true  → detect, REDACT, continue
  scan_secrets=false                         → no detection, no redaction

But the actual MCP-server code never honored the second case. Every
tool's abort guard was a flat `if (xxxScan)` that returned an isError
response the moment scanFilesForSecrets() found anything — regardless
of whether redact_secrets was also true. The default v9.0.0 fix-loop
invocation on this very repo hit the bug immediately: the scan aborted
on env-variable-NAME references in the plugin's own source (e.g.
$OPENROUTER_API_KEY in mcp-server/src/config.ts) instead of redacting
and continuing.

Fix: at every abort guard (10 sites, one per tool entry point), wrap
the condition with `&& !xxxRedact`. When the caller asked for both
scan and redact, the abort is skipped — downstream readAndGroupFiles
+ the inline-content branch already call redactSecrets() to replace
every match with [REDACTED:LABEL] before the LLM ever sees it. The
bytes the upstream LLM gets are identical to what scan-then-abort
would have prevented; the user just doesn't lose the run.

Sites updated (all in mcp-server/src/index.ts):

  chat:                          line 5067 → if (chatScan && !chatRedact)
  code_task:                     line 5360 → if (ctScan   && !ctRedact)
  batch_check:                   line 6020 → if (bcScan   && !bcRedact)
  scan_folder:                   line 6379 → if (sfScan   && !sfRedact)
  search_existing_implementations: line 6869 → if (seiScan && !seiRedact)
  compare_files (single):        line 7514 → if (cfScan   && !cfRedact)
  compare_files (comparePair):   line 7321 → if (cfScan   && !cfRedact)
  check_references:              line 7695 → if (crScan   && !crRedact)
  check_imports:                 line 7951 → if (ciScan   && !ciRedact)
  check_against_specs:           line 8312 → if (csScan   && !csRedact)

Updated the doc comment at lines 324-334 to describe the three modes
explicitly (was a two-line summary that said abort and redact were
distinct alternatives — the new comment makes the composition clear).

Validation: typecheck clean, build clean, eslint clean
(--max-warnings 0), all 51 vitest tests pass. Pre-existing
'Server is deprecated' diagnostics on lines 38 and 4912 are
unrelated to this change.

Backwards compat: callers that send only scan_secrets:true (no
redact_secrets) still abort on detection — same behaviour as before.
The new path activates only when both flags are true, which was
previously broken / undocumented.


## [9.0.0] - 2026-04-18

### Added

- Feat!: 8 fixes from user review — sonnet/opus split, menus, checkpoint, redact default, qwen, ollama, troubleshooting

BREAKING: the two opus-only fixer agents are split into sonnet + opus
variants (4 agents total), so the fixer commands can pre-bake the
user's model pick and dispatch directly. Users dispatching the old
agent names from custom commands MUST update to the *-sonnet-agent or
*-opus-agent variants:

  llm-externalizer-parallel-fixer-agent  -> llm-externalizer-parallel-fixer-sonnet-agent
                                          + llm-externalizer-parallel-fixer-opus-agent
  llm-externalizer-serial-fixer-agent    -> llm-externalizer-serial-fixer-sonnet-agent
                                          + llm-externalizer-serial-fixer-opus-agent

Eight user-requested changes:

1. `redact_secrets` default flipped to true when `scan_secrets` is true.
   Previous default aborted the whole run if any secret was detected;
   now the default is to REDACT (replace with [REDACTED:LABEL]) and
   keep scanning. Users who want the old abort behaviour can still get
   it by running with --no-secrets and enabling a stricter external
   pre-flight, but the sensible default for "wise" secret scanning is
   redact-not-abort. All 4 scan-and-fix variants updated; the scan
   call now sends scan_secrets + redact_secrets as a pair.

2. All user-facing choice prompts moved to AskUserQuestion menus with
   the yes/default option first, so pressing Enter takes the obvious
   path:
     - Auto-discovery confirm step: Proceed (default) / Edit list / Cancel.
     - Fixer-model pick step: Sonnet (default) / Opus.
   No more "type y to continue" text prompts.

3. Step 0 output trimmed: one line each for codebase root, file count
   + top-level breakdown, included examples, excluded examples. Then
   the menu. No prose lectures before the scan.

4. Pre-fix checkpoint step added to all four fix-touching commands
   (scan-and-fix, scan-and-fix-serially, fix-report, fix-found-bugs).
   Before any fixer touches source, the orchestrator creates a
   `chore(checkpoint): ...` commit if the tree has uncommitted
   changes, so the user can always revert with one `git reset --soft
   HEAD~1`. No menu — checkpointing is cheap and always safe.

5. Ensemble model list completed in both the README and the YAML
   example. The Remote (OpenRouter) block now shows third_model:
   "qwen/qwen3.6-plus" alongside gemini-2.5-flash and grok-4.1-fast.
   remote-ensemble requires three models — the doc now states this.

6. Fixer model is now picked via menu (Sonnet default, Opus optional),
   and the four new agent files hard-code the picked model. Splitting
   into two files per fixer role keeps the `model:` frontmatter field
   honest and the CPV validator happy (effort: xhigh needs Opus;
   sonnet variants use effort: high).

7. LM Studio default switched from the old Llama-3.3-70B-GGUF to the
   recommended Qwen 3.5 27B with platform-split guidance:
     * mlx-community/Qwen3.5-27B-Instruct-4bit   (macOS Apple Silicon)
     * bartowski/Qwen3.5-27B-Instruct-GGUF       (Windows / Linux)
   One comment line in the profile explains which to pick.

8. Two new README sections:
     * "Local (Ollama)" — full profile example, `ollama pull` hint,
       url override note.
     * "## Troubleshooting" — 4 tables (OpenRouter / LM Studio /
       Ollama / General) covering the common symptoms users hit:
       missing env vars, 401/429 errors, model-not-found, timeouts,
       MLX-vs-GGUF pick on Mac, daemon not running, etc.

Also dropped editorializing on model quality. The README used to say
free mode is "LOWER quality than ensemble — expect more false
positives and shallower analysis" and similar on --free in the
scan-and-fix tables. Those are design decisions we already committed
to — readers don't need the caveat. Kept the one truly material
warning on free mode: the provider logs prompts.

Rule file synced: rules/use-llm-externalizer.md lists all 5 agents and
the Sonnet/Opus menu, and the user-global ~/.claude/rules/ copy
mirrors the plugin version byte-for-byte so next-install users get
the same guidance.

Validation: all agents 100/100, all commands 100/100, plugin clean
(only the pre-existing mcp-server/ directory WARNING, unchanged).


## [8.1.2] - 2026-04-18

### Documentation

- Docs(readme): split user install vs dev install; marketplace link at top

Three related fixes per user feedback:

1. Marketplace visibility at the top.
   Right under the tagline a [!NOTE] banner spells out the plugin
   ships in Emasoft/emasoft-plugins (with a link). Anyone reading
   the README — Claude Code included — can see which marketplace to
   add before the install commands even start.

2. Quick start = USER install only, via the Claude Code CLI.
   Rewrote the whole Quick start section around `claude plugin …`
   CLI commands (not inside-Claude slash commands), step-by-step:

     1. claude plugin marketplace add Emasoft/emasoft-plugins
     2. claude plugin marketplace update emasoft-plugins
     3. claude plugin install llm-externalizer@emasoft-plugins
     4. claude plugin update llm-externalizer
     5. claude plugin uninstall llm-externalizer

   Each with a short "why". Pointer at the top to `claude plugins
   --help` for the full reference.

   The old "alternative: manual settings.json" branch and the
   "/plugin ..." slash-command flow are gone from Quick start —
   those belong in the Claude Code docs, not here.

   Added a dedicated subsection "How to install from inside Claude
   Code" that is deliberately one sentence: "Paste the URL of this
   repository in the prompt and ask Claude to install it for you as
   a project, local, or user scope plugin."

3. Contributing = DEV install at the bottom, with the exact command
   sequence a contributor needs:

     fork -> clone -> add upstream -> scripts/setup.py -> local
     install -> feature branch -> claude plugin validate +
     cpv-remote-validate -> conventional-commit -> push fork ->
     gh pr create

   Added an [!IMPORTANT] banner explaining the pre-push hook blocks
   direct git push to upstream; only scripts/publish.py (run by the
   maintainer) ships a release, and it runs the 9 mandatory
   validation gates every time.

   Developer requirements (uv, gh, git-cliff) live here now —
   Requirements section up top only lists what a regular marketplace
   user needs, with a pointer to this section for devs.

   Release pipeline subsection shows every scripts/publish.py flag
   (--patch / --minor / --major / --dry-run / --check-only) so
   maintainers don't have to `--help` to remember.

Net: user path is top-to-bottom (marketplace, install, configure,
run). Dev path is anchored at the bottom with the full fork-build-PR
sequence. No duplicate Requirements list, no inside-Claude-slash-
command install noise in Quick start.


## [8.1.1] - 2026-04-18

### Documentation

- Docs(readme): full restructure — TOC, user-first order, concise features, colored alerts

You called it: the previous README was bloated, duplicated, out of
order, and had no TOC. This rewrite takes it from 599 lines to 380
(-37%) without losing any end-user-facing detail.

What's different:

1. Order now follows "what a new user needs first":
     badges -> tagline -> cost graph -> TOC -> Features -> Requirements
     -> Quick Start -> Commands -> Agents -> Configuration ->
     MCP tools reference -> Skills -> Plugin structure -> Contributing
     -> License -> Links
   Requirements + Quick Start used to be at line 580+. Now they're
   at the top, right under the TOC, as they should be.

2. Features list shrunk from a 15-bullet dump (each with inline
   detail) to 9 one-line bullets that LINK into the dedicated
   sections. Details live where they belong, not in the summary.

3. Table of contents added — 12 section anchors.

4. Colored banner titles via GitHub Alert blocks:
     > [!TIP]      — "Why this plugin exists" + serial-vs-parallel guidance
     > [!NOTE]     — marketplace-refresh tip + auth auto-detection
     > [!IMPORTANT]— MCP batching limits
     > [!WARNING]  — free-tier prompt-logging caveat
   These render as coloured side-panels on GitHub / VS Code preview.

5. Duplicated content removed:
   * "Cost comparison" subsection (graph was already in the hero
     section one line below)
   * "LLM Externalizer (external model analysis)" section — this
     was a pasted skill-prose block, not README material
   * "Read-only by design — disabled tools" — historical noise
     about dead code in the MCP server
   * "Key constraints" and "Subagent access" sections — internal
     implementation detail, not user-facing
   * "Naming" section — one-off cleanup commentary
   * Duplicate "answer_mode" descriptions in 3 places condensed to
     one table

6. Plugin structure tree collapsed into a <details> block — the
   full tree was 60+ lines of dev detail; users rarely need it but
   it's still there for when they do.

7. Publishing section shrunk to a 3-line Contributing summary.
   Detail lives in scripts/publish.py's --help.

8. Command parameter tables preserved in full — they were requested
   earlier and are the genuine user-facing reference.

Score impact: validation stays clean (0 CRITICAL / 0 MAJOR / 0 MINOR
/ 0 NIT / 1 pre-existing unrelated WARNING about mcp-server/).


## [8.1.0] - 2026-04-18

### Added

- Feat: auto-switch answer_mode to 1 when --file-list contains group markers

Both scan commands now auto-detect the presence of ---GROUP:<id>---
markers in the user-supplied --file-list and, when present, set
answer_mode=1 on the mcp__llm-externalizer__code_task call. Without
markers (or when the scan goes through scan_folder on Branch B), the
mode stays at the default 0 (one report per file).

Why: users who put group markers in their file list expect a report
per group (that's the whole point of grouping). Silently keeping
answer_mode=0 produced per-file reports that fragmented the grouping
intent — the MCP server still packed the files per-group into the
LLM request, but the reports came back split.

Implementation in the command prose:

  ANSWER_MODE=0
  if [ -n "$FILE_LIST_PATH" ] && \
     grep -Eq '^---GROUP:[A-Za-z0-9_.-]+---[[:space:]]*$' "$FILE_LIST_PATH"; then
      ANSWER_MODE=1
  fi

Then the scan JSON uses <ANSWER_MODE> instead of a hardcoded 0. Branch
B (folder scan via scan_folder) always uses 0 — scan_folder
auto-discovers paths and doesn't accept group markers. The orchestrator
also logs a one-line notice ("File list contains group markers — using
answer_mode=1 (one report per group)") so the user knows why the
output shape differs from the default.

Downstream pipeline is unchanged:
  * parallel-fixer dispatch (scan-and-fix): each group report -> one
    fixer. Same as per-file.
  * aggregator (scan-and-fix-serially): walks every .md in the
    reports dir. Group reports work the same as per-file reports.

Constraint section updated: "answer_mode is hardcoded to 0" is now
"answer_mode is chosen by the command itself: 0 default, 1 if file
list has group markers, never 2, never overridable from $ARGUMENTS".

README table entry for --file-list now explicitly states the
auto-switch ("if the file contains at least one ---GROUP:<id>--- line,
the command automatically uses answer_mode: 1 instead of the default
answer_mode: 0").


## [8.0.2] - 2026-04-18

### Documentation

- Docs(readme): expand parameter tables with defaults + behaviour nuances

You asked: does the doc say what happens when no target AND no
--file-list are passed? Does it explain that a file list with
---GROUP:id--- markers produces per-group reports instead of per-file?
The answers were "barely" and "no" — fixed.

Every parameter table now has a dedicated "Default" column and
expanded "Meaning" prose covering the subtle cases a reader would
otherwise miss:

scan-and-fix / scan-and-fix-serially:
  * [target] — default behaviour is DEFAULT-TO-SCANNING-THE-WHOLE-
    CODEBASE (auto-discover tracked files, filter non-source, confirm
    with the user, treat as implicit --file-list). Explicit that the
    command does NOT silently hand a folder to scan_folder.
  * --file-list — documented the ---GROUP:id--- marker semantics:
    lines between ---GROUP:id--- and ---/GROUP:id--- are packed into
    ONE LLM request and produce ONE report per group instead of one
    per file (basename carries _group-<id>_). Also: empty list
    aborts.
  * --instructions — described what the DEFAULT rubric is (REAL
    bugs only, strict exclusions for style / try-except / null-
    checks / refactors).
  * --specs — explicit that each batch sees source+spec, making
    cross-reference validation trustworthy (unlike the default
    rubric's best-effort local-only check).
  * --free — called out that it's LOWER quality than the ensemble
    and that the provider LOGS PROMPTS (don't use on proprietary
    code).
  * --no-secrets — clarified that default behaviour ABORTS the run
    if a secret is found (safety net, not silent redaction).
  * --text — clarified that the default rubric has nothing useful
    to say about prose and should be paired with --instructions.

search-existing-implementations:
  * --base — explicit auto-detect chain (origin/HEAD → main →
    master).
  * --max-files — default 10000 stated with the reason (designed
    for massive PR-review scans).
  * Added output spec (one line per file, exhaustive, answer_mode=2
    merged report).

fix-report:
  * Added explicit .fixer. / .final-report. basename rejection up
    front, relative-path resolution rule.

fix-found-bugs:
  * The DEFAULT when no arg is supplied is now explicit: aggregate
    EVERY report in ./reports/llm-externalizer/, skip any with a
    .fixer. sibling.
  * Stated the MAX_ITER formula and stuck-streak safety rail.

All tables now gain a Default column; tables that had no default
(required positional only) still show "—" so the column is
consistent across commands.


## [8.0.1] - 2026-04-18

### Documentation

- Docs: per-command parameter tables in README + bundle the use-llm-externalizer rule file

Three changes:

1. README.md: every slash command now has its own parameter table
   (positional + flag) with Kind / Required / Meaning columns. Each
   table is preceded by a short behaviour summary so readers can see
   what the command does without following every link. Tables added
   for:
     - llm-externalizer-discover  (no params)
     - llm-externalizer-configure (no params)
     - llm-externalizer-search-existing-implementations (2 positional
       + 5 flags)
     - llm-externalizer-scan-and-fix (target + 6 flags)
     - llm-externalizer-scan-and-fix-serially (cross-references the
       scan-and-fix table since the parameter set is byte-identical)
     - llm-externalizer-fix-report (one positional)
     - llm-externalizer-fix-found-bugs (one optional positional)

   The original compact overview table stays at the top so existing
   links to "## Commands" still land on a readable summary.

2. rules/use-llm-externalizer.md NEW: plugin-bundled copy of the
   per-user global rules file at ~/.claude/rules/use-llm-externalizer.md.
   Having the canonical content ship with the plugin means new installs
   get the up-to-date guidance without the user having to hand-copy
   anything. The two files are byte-identical as of this commit and
   should be synced together on future edits.

3. The plugin-bundled rule file already reflects the v8.0.0 renames:
     * Agent names: llm-ext-reviewer -> llm-externalizer-reviewer-agent
       (the rest are llm-externalizer-parallel-fixer-agent and
       llm-externalizer-serial-fixer-agent)
     * Flag renames: --no-scan-secrets -> --no-secrets,
       --text-files -> --text
   So anyone installing v8.1.0 gets current docs out of the box.


## [8.0.0] - 2026-04-18

### Added

- Feat!: shorten scan-phase flag names

BREAKING: two flags on both scan commands are renamed:

  --no-scan-secrets  ->  --no-secrets
  --text-files       ->  --text

Users who invoked scan-and-fix or scan-and-fix-serially with the old
flag names must update their commands.

Motivation: CPV's command validator warns when argument-hint > ~100
chars ("may be truncated in UI"). With both flags visible in the hint
(as you asked), the old spelling came in at 108 chars and both
commands scored 97/100. The shorter names cut the hint to 97 chars
and both commands are now at 100/100.

Semantically the flags are unchanged: --no-secrets still disables the
pre-scan secret detector (scan_secrets: false); --text still widens
the scan to include plain-text formats (.md .txt .json .yml .yaml
.toml .ini .cfg .conf .xml .html .rst .csv) instead of the default
source-code extensions.

Also dropped a stale 'effort: high' line from scan-and-fix.md's
frontmatter — it's not in the plugin-shipped command allowed-fields
set (CPV warning), and the command runs fine without it. scan-and-fix
is already dispatched with the effort inherited from the model
config, so the field was a no-op anyway.


## [7.1.2] - 2026-04-18

### Fixed

- Fix(commands): make scan phase identical across scan-and-fix and scan-and-fix-serially

Two related fixes:

1. Restore --no-scan-secrets and --text-files in both commands'
   argument-hint. They were silently dropped from the hint in v7.1.1
   (still usable per the Arguments doc and the scan_folder / code_task
   JSON calls, but invisible from the slash-command menu — user
   couldn't see they were options). Now both commands show the full
   flag set:

   [target] [--file-list path] [--instructions path] [--specs path]
     [--free] [--no-scan-secrets] [--text-files]

2. Make the scan phase (Step 0 auto-discovery through Step 3b report
   validation) byte-identical between the two commands. The previous
   scan-and-fix-serially version condensed the prose for brevity; the
   result was functionally equivalent but visually diverged. Now Step
   0-3b in scan-and-fix-serially is a verbatim copy of the same
   section in scan-and-fix, minus three necessary deltas:

   a. [FAILED] prefix strings use the invoking command's name (user
      doesn't see the wrong command in an error message).
   b. Step 3b heading: "before dispatching fixers" (scan-and-fix) vs
      "before the aggregator" (serially) — the two commands use the
      validated list for different downstream steps.
   c. The "Token-budget note for very large scans" section is
      parallel-dispatch-specific; serially does not need it.

   Added a visible marker at the end of serially's Step 3b noting that
   the whole scan phase is a mirror of scan-and-fix's and must stay in
   sync on future edits.

Outcome: a user reading the two commands sees the same scan pipeline
end-to-end and can trust that switching between parallel and serial
fix modes does not quietly change how the codebase is scanned.


## [7.1.1] - 2026-04-18

### Fixed

- Fix(commands): make scan-and-fix-serially self-contained (command -> agent, no nested command chain)

Previous v7.1.0 draft relied on cross-command references ("follow
scan-and-fix Steps 0-3b, then follow fix-found-bugs Steps 4-8"),
which forces the orchestrator to open the other command files at
runtime — more tokens, more indirection, and the wrong orchestration
pattern (command -> command -> agent instead of command -> agent).

Rewrite as a single self-contained command: the scan phase, the
aggregator call, the canonicalisation step, and the serial fix loop
are all inlined here. The only outgoing Task call is to
llm-externalizer-serial-fixer-agent (plus the MCP scan calls and
helper-script invocations, which are data/tooling, not command
chaining). No "see scan-and-fix.md" or "see fix-found-bugs.md"
pointers remain.

The command is longer on disk (~230 lines vs 63 in the v7.1.0 draft)
but the steady-state cost is lower: a user who invokes this command
loads ONE command's prose, not three. The earlier "delta-only" doc
looked shorter but made every invocation pay the cost of resolving
the cross-references.

Also trimmed:
- description: 300 -> 193 chars (was over the 250-char slash-menu cap)
- argument-hint: dropped rarely-used [--no-scan-secrets] and
  [--text-files] entries (108 -> 83 chars; they're still documented
  in the Arguments section)


## [7.1.0] - 2026-04-18

### Added

- Feat: add /llm-externalizer:llm-externalizer-scan-and-fix-serially command

Composition command that reuses the scan phase from scan-and-fix and
the serial loop from fix-found-bugs:

  scan (parallel per-file reports)
    -> aggregate into one canonical bug list
    -> serial llm-externalizer-serial-fixer-agent loop (1 bug / dispatch)

Use this instead of scan-and-fix when fixes mutate shared state
(imports, types, schemas, shared mocks) — running 15 parallel fixers
would race — or when bug order matters (an earlier fix may supersede
or unblock a later one).

The command body is deliberately terse: ~60 lines of delta-only prose
pointing back to the two existing commands rather than re-inlining
their orchestration. Every token loaded into the slash-command
context is a token the orchestrator pays for — the longer the
description, the higher the floor per invocation. Treating this
command as "scan-and-fix scan phase + fix-found-bugs serial phase,
with these four deltas" keeps the marginal cost low.

README updates:
- 6 slash commands -> 7, new command added to the top bullet
- Commands table row added, describing the serial/stateful trade-off
- Plugin structure tree includes the new commands/*.md entry


## [7.0.0] - 2026-04-18

### Added

- Feat!: rename fixer agents by concurrency model (parallel / serial)

BREAKING: both Opus-class fixer agents are renamed to spell out the
fundamental design distinction — concurrency — directly in the name:

  llm-externalizer-fixer-agent      -> llm-externalizer-parallel-fixer-agent
  llm-externalizer-bug-fixer-agent  -> llm-externalizer-serial-fixer-agent

The pair "fixer" vs "bug-fixer" was ambiguous — both agents fix bugs,
and a reader couldn't tell from the name which was which. The real
design axis is how they execute:

- parallel-fixer-agent: stateless, writes a .fixer. summary per report,
  dispatched up to 15 in parallel against a folder-wide scan
- serial-fixer-agent: stateful on disk (mutates the aggregated bug
  list with " — FIXED" markers), dispatched one at a time in a loop
  over one bug list

Reviewer-agent name is unchanged (it's read-only, not a fixer).

Touched everywhere: agent files (git mv + frontmatter name: field +
internal BACKUP path prefixes + [FAILED] messages + example dialog),
command Task dispatches and descriptions, README features + commands
table + plugin structure, scripts (fix_found_bugs_helper.py help text,
validate_fixer_summary.py docstring). CHANGELOG entries are historical
commit records and were left untouched.


## [6.0.0] - 2026-04-18

### Added

- Feat!: rename agents with -agent suffix + add llm-externalizer-fix-report command + drop line-count CANTFIX cap

BREAKING: all three plugin-shipped agents are renamed. Any user config,
slash-command script, or Task dispatch that references the old names
must be updated:

  llm-externalizer-fixer      -> llm-externalizer-fixer-agent
  llm-externalizer-reviewer   -> llm-externalizer-reviewer-agent
  llm-externalizer-bug-fixer  -> llm-externalizer-bug-fixer-agent

Motivation: the `-agent` suffix makes agents visibly distinct from
commands in the slash-command menu and in logs. Commands are the
user-facing surface; agents are internal dispatch targets that the user
should NOT invoke directly. The naming makes this hierarchy obvious.

Updated everywhere the old names appeared: agent frontmatter `name:`
fields, example dialog lines, /tmp BACKUP path prefixes, command
`subagent_type:` dispatches, README features list + commands table +
plugin-structure block, skill frontmatter `agent:` field, and doc
references in scripts. CHANGELOG entries are historical commit records
and were left untouched.

New command: `/llm-externalizer:llm-externalizer-fix-report`. Wraps a
single `llm-externalizer-fixer-agent` dispatch for one already-generated
per-file scan report — the single-file counterpart to the parallel
dispatcher in `scan-and-fix`. User-facing surface now has a command per
fixer agent: `scan-and-fix` + `fix-report` invoke `fixer-agent`;
`fix-found-bugs` invokes `bug-fixer-agent`. Users should never need to
call an agent directly.

Rules change in both fixer agents: remove the ">10 lines of rewrite"
clause from the CANTFIX-escalation rule. Size of the fix is no longer
a reason to escalate — only SCOPE growth (touching another file or
changing a public API) does. A large in-file rewrite with
mcp__serena-mcp__replace_symbol_body is fine.

Files touched:
- agents/llm-externalizer-{fixer,reviewer,bug-fixer}.md renamed to
  *-agent.md; frontmatter name: fields updated; internal refs updated
- commands/llm-externalizer-fix-report.md NEW
- commands/llm-externalizer-{scan-and-fix,fix-found-bugs}.md refs
  updated
- skills/llm-externalizer-scan/SKILL.md agent: field updated
- scripts/fix_found_bugs_helper.py help text updated
- scripts/validate_fixer_summary.py docstring updated
- README.md features, commands table, plugin structure updated


### Fixed

- Fix(reviewer): upgrade model from haiku to sonnet

User reports the Haiku-class reviewer hallucinates too often to be
trusted on real-code audits — upgrade to Sonnet to improve signal-to-
noise. The reviewer is read-only (no Write/Edit in its tool surface)
so this is a pure capability/cost upgrade, not a scope change.

- agents/llm-externalizer-reviewer-agent.md: model: haiku -> sonnet
- README: "Haiku-class" -> "Sonnet-class" (features bullet + plugin
  tree comment)
- skills/llm-externalizer-scan/SKILL.md: "(Haiku, no Write/Edit)" ->
  "(Sonnet, no Write/Edit)"


## [5.2.1] - 2026-04-18

### Documentation

- Docs(agent): mirror the 10-rule block from llm-externalizer-fixer

Add a '## Rules' summary at the end of llm-externalizer-bug-fixer,
mirroring the block already present in llm-externalizer-fixer so the
two agents look the same at a glance.

Adaptations for the bug-fixer's role (fix from a markdown bug list
rather than from a scan report):

- Rule 4 — source of truth is the bug file + the real source tree
  (validate_report.py / validate_fixer_summary.py don't exist in this
  flow).
- Rule 5 — CANTFIX note must be appended to the bug body with a
  timestamp (RUN_TS) so future runs see the prior attempt.
- Rule 10 — return exactly one status line of the four allowed shapes
  (Fixed / False-positive / CANTFIX / [FAILED]) rather than a summary
  path; a missing or multi-line return breaks diff-fixed parsing.
- Rule 2 — add a pointer to SERENA replace_symbol_body (matches the
  tool-selection rule added earlier).


## [5.2.0] - 2026-04-18

### Added

- Feat(agent): prefer SERENA replace_symbol_body for whole-symbol rewrites

Add an explicit tool-selection rule for the llm-externalizer-bug-fixer:

- whole-function / whole-method / whole-class rewrite →
  mcp__serena-mcp__replace_symbol_body (AST-scoped, preserves
  indentation and cannot spill into adjacent symbols)
- insert code around a symbol → insert_before_symbol / insert_after_symbol
- rename a symbol → rename_symbol
- delete an unused symbol → safe_delete_symbol (after find_referencing_symbols
  confirms 0 external refs)
- single-line / in-symbol textual patch → built-in Edit

Rule of thumb: if the replacement contains a def / class / fn block,
use replace_symbol_body; if it's a snippet inside one, use Edit.

Also update the regression-check step to re-read modified symbols via
SERENA's find_symbol (include_body: true) when the edit was symbol-scoped
— matches the editing tool used.

Motivation: textual Edit is fragile on whole-function rewrites because
it matches by unique substring and silently fails when indentation
drifts or when the function appears twice in the file. SERENA's
symbol-scoped edit tools address both issues and are already in the
agent's inherited tool surface.


### Fixed

- Fix(agent): let llm-externalizer-bug-fixer inherit full tool surface

Remove the narrow Read/Edit/Write/Bash/Grep/Glob allowlist so the agent
can use SERENA MCP, TLDR, and Grepika (plus LSP diagnostics and any
other MCP tools configured in the session) to trace flow before editing.

Mirrors the pattern already used by llm-externalizer-fixer — a narrow
tools: line starves the agent of the cheap, symbol-aware tools it needs
to verify findings before touching source, which is exactly the verify-
before-edit behaviour the agent body already asks for.

Also update the "Read the referenced code" rule to name Grepika
(mcp__grepika__search / refs / outline) alongside SERENA and TLDR, so
the agent explicitly knows which tools to reach for before Grep.


## [5.1.1] - 2026-04-18

### Documentation

- Docs: update README features list for v5.1.0

Mention the new llm-externalizer-bug-fixer agent and bump the
slash-command count from 4 to 5 (added llm-externalizer-fix-found-bugs).


## [5.1.0] - 2026-04-18

### Added

- Feat: add llm-externalizer-fix-found-bugs command

Aggregate unfixed findings across every report under ./reports/llm-externalizer/
(merging the 3 per-model auditor responses when ensemble mode was used) into one
canonical bug list, then dispatch one fresh llm-externalizer-bug-fixer subagent
per bug until none remain. Pass @merged-report.md as the argument to scope the
loop to a single merged (answer_mode=2) report.

Each dispatch is a fresh spawn with zero parent-conversation context. The loop
is serial by design — later bugs may be superseded by fixes in earlier ones.
The orchestrator never reads scan or fixer content, only paths.

- commands/llm-externalizer-fix-found-bugs.md — orchestrator (argument-hint:
  "[@merged-report.md]")
- agents/llm-externalizer-bug-fixer.md — Opus-class per-bug fixer with
  REAL-BUG / FALSE-POSITIVE / HALLUCINATION / CANTFIX classification, /tmp
  backup + rollback on regression, per-language linter verification
- scripts/fix_found_bugs_helper.py — backend with 10 subcommands including
  the new aggregate-reports that handles ensemble (## Response per-model
  sections), merged (## File: sections), and single-model report shapes
  with keyword-based severity classification; --skip-if-fixer-exists skips
  reports already processed by scan-and-fix
- README + CHANGELOG updated


## [5.0.0] - 2026-04-18

### Added

- Feat!: read-only MCP + dead-code purge + deep audit pass

BREAKING: LLM Externalizer MCP is now read-only by design.

MCP write tools removed entirely (not just disabled): fix_code,
batch_fix, merge_files, split_file, revert_file, set_settings,
change_model. File fixes are applied exclusively by the
/llm-externalizer:llm-externalizer-scan-and-fix plugin command,
which dispatches local agents using Claude Code's Read+Edit.
Model & profile configuration is user-only — edit
~/.llm-externalizer/settings.yaml manually, then restart or call
the reset tool.

CLI mutation subcommands removed: profile add / select / edit /
remove / rename no longer exist. Only 'profile list' remains.

Supporting dead code also removed: DISABLED_TOOLS mechanism,
fix_code_response / split_file_response schemas, file-locking
subsystem (acquireFileLock / releaseFileLock), git-branch monitor
(getGitBranch / assertBranchUnchanged), path-traversal guard
(sanitizeOutputPath), BOM + line-ending preservation
(hasBOM / detectLineEnding / restoreFileConventions),
verifyStructuralIntegrity, reversible redaction
(TrackedRedaction / redactSecretsReversible / restoreSecrets /
formatLostSecrets), withWriteQueue, processFileFix, getBackupDir.
In config.ts: saveSettings and related write helpers. Net:
index.ts dropped from ~10k to 8.5k lines.

Scan rubric tightened across agents/commands/skills: report REAL
bugs only (logic errors, crashes, security with exploit paths,
data corruption, functionality mismatch, local broken references).
Missing error handling / null checks / input validation / logging
/ refactoring suggestions are treated as style preferences and
must NOT be reported. Fixer agent gained a 4-bucket finding
classifier (REAL BUG / STYLE PREFERENCE / HALLUCINATION /
EXAGGERATION / CANTFIX) applied before every edit. Reviewer and
fixer no longer declare a tools: allowlist — they inherit the
full tool surface (SERENA MCP, TLDR, Grepika, LSP).

Docs swept: README, CHANGELOG, commands/llm-externalizer-configure,
skills/llm-externalizer-config, skills/llm-externalizer-usage,
skills/llm-externalizer-scan, skills/llm-externalizer-free-scan,
bin/llm-ext, in-source tool descriptions — all now state the
read-only + manual-edit policy explicitly. Validator error messages
in config.ts updated to point at manual YAML edit + reset.

CPV audit fixes:
  - Plugin: 0 CRIT / 0 MAJ / 0 MIN (was 0/2/2/6 WARN)
  - Agents: fixer + reviewer both 100/100 (was 87/87) — added 2
    <example> blocks each in the body, moved them out of the
    description to avoid angle-bracket prompt injection
  - Commands: all 4 at 100/100 — shortened long descriptions,
    removed angle brackets, dropped empty argument-hint
  - Skills: all 5 at 100/100 Grade A — trimmed scan SKILL.md to
    under 5000 chars, added 'Use when...' prefix to config
    SKILL.md, fixed TOC coverage in free-scan and usage SKILLs,
    renamed 'Instructions (read-only inspection)' to 'Instructions'
  - XREF: 100/100 — reworded prose in CHANGELOG that CPV was
    misparsing as skill references

Python: ruff + pyright clean. Added 'typing.Any' to statusline.py
safe_jq so pyright stops widening dict.get() to Unknown. Removed
unused 'datetime.timezone' import. Removed dead _exists helper in
check_references.py. All Python files ruff format-normalized.

YAML: added pragmatic .yamllint.yml (line-length 200, disabled
document-start, disabled truthy.check-keys for GitHub Actions
'on:' key). Split long client-payload in notify-marketplace.yml.

Test suite: 51 tests pass. Updated index.test.ts expected-tools
list to drop set_settings/change_model; rewrote the disabled-tools
test to match current reality; removed change_model + discover
round-trip test from live-extended.test.ts.

Gitignore: removed uv.lock (scripts are stdlib-only).
Committing an empty lockfile so tooling has a pin reference.


## [4.1.5] - 2026-04-17

### Documentation

- Docs(scan): warn that LLM cannot cross-reference files — 1-5 per batch

Added a fundamental-limitation warning: the LLM sees only 1-5 files
per request (FFD ~400 KB batches, or one ---GROUP:id--- group).
It cannot verify that a reference in file A exists in file B or
anywhere else in the codebase — no single LLM call ever has global
visibility, so the default 'broken references' heuristic is
best-effort LOCAL only.

For real cross-file validation, users must use:

  * mcp__llm-externalizer__check_against_specs (or the --specs
    flag on /llm-externalizer:llm-externalizer-scan-and-fix): each
    batch includes the authoritative spec, so every reference is
    validated against it instead of against 'whatever the LLM
    thinks exists elsewhere'.
  * mcp__llm-externalizer__search_existing_implementations
    (or the search-existing-implementations command): purpose-built
    for 'is this already implemented?' cross-codebase hunts,
    comparing each file against a REFERENCE description rather
    than against other files.

Changes:

  - commands/llm-externalizer-scan-and-fix.md: full warning block
    immediately after the HARDCODED section.
  - skills/llm-externalizer-scan/SKILL.md, -free-scan, -usage:
    merged the previous '.md files' rule with the new cross-file
    warning into one '## Limitations' section (kept SKILL.md
    sizes under CPV's 5000-char progressive-disclosure cap by
    dropping the redundant Batching paragraph, whose content is
    now in Limitations).

Verified:
  CPV: 0 CRITICAL / 0 MAJOR / 0 MINOR (WARNING=6 all pre-existing)
  check_references.py --strict: 0 broken, 0 dynamic


## [4.1.4] - 2026-04-17

### Documentation

- Docs: rename 'Analyze multiple files together' -> 'in parallel'

'Together' wrongly suggested the LLM can see every file in a single
request. It cannot — the server batches 1–5 files per LLM call
(FFD ~400 KB budget) or one group per call when ---GROUP:id---
markers are used. 'In parallel' accurately describes the multi-file
behavior from the LLM's point of view: each file gets processed,
and in ensemble mode each file gets 3 responses concurrently from
3 different models.

Renamed across 6 files:

  - skills/llm-externalizer-scan/references/usage-patterns.md
    (heading + TOC link + anchor slug)
  - skills/llm-externalizer-free-scan/references/usage-patterns.md
    (same)
  - skills/llm-externalizer-usage/references/usage-patterns.md
    (same)
  - skills/llm-externalizer-scan/SKILL.md
    (embedded TOC text)
  - skills/llm-externalizer-free-scan/SKILL.md
    (embedded TOC text)
  - skills/llm-externalizer-usage/SKILL.md
    (embedded TOC text)

Verified:
  CPV: CRITICAL=0 MAJOR=0 MINOR=0 (WARNING=6 all pre-existing)
  check_references.py --strict: 0 broken, 0 dynamic


## [4.1.3] - 2026-04-17

### Documentation

- Docs: avoid 'references/imports' prose that my own checker reads as a path

check_references.py flagged the slash-separated 'references/imports'
as a broken path reference. Replaced with 'check broken references,
check broken imports' (two items) — which also matches the actual
reference file's section names more accurately.

- Docs: shrink .md-scan rule block to stay under CPV's 5000-char SKILL.md cap

The ~900-char rule block I added to the three SKILL.md files
pushed each over the CPV-enforced 5000-character limit for
progressive-disclosure skill files. CPV correctly blocked the
publish — this commit compresses the inline version to ~300 chars
(two sentences) while keeping the full rule in
commands/llm-externalizer-scan-and-fix.md where no char limit
applies.

Also trimmed the llm-externalizer-scan SKILL.md Examples block
(redundant with references/usage-patterns.md) and shortened the
Resources descriptions to fit the budget.

Verified:
  - CPV: 0 CRITICAL, 0 MAJOR (was 3 MAJOR)
  - check_references.py --strict: 0 broken

- Docs: propagate .md-exclusion + no-structural-validation rules to all scanners

The rule "don't waste LLM tokens auditing .md files with a
source-code rubric, and don't use the LLM for structural
validation — CPV and `claude plugin validate` do that better,
cheaper, deterministically" applies to every scanning entity in
this plugin, not just /llm-externalizer-scan-and-fix.

Added the same rule block to:

  - skills/llm-externalizer-scan/SKILL.md
  - skills/llm-externalizer-free-scan/SKILL.md
  - skills/llm-externalizer-usage/SKILL.md
  - commands/llm-externalizer-search-existing-implementations.md
    (adapted — this command's semantic-duplicate-detection use
    case is LLM-only, so the block is phrased as "don't use this
    for what validators do better" instead of "exclude .md by
    default")

Left untouched (no scanning behavior, rule doesn't apply):

  - commands/llm-externalizer-configure.md
  - commands/llm-externalizer-discover.md
  - skills/llm-externalizer-config/SKILL.md
  - skills/llm-externalizer-or-model-info/SKILL.md


### Fixed

- Fix(cpv): satisfy progressive-disclosure TOC + shebang+exec warnings

CPV blocked the v4.1.3 publish with MAJOR/MINOR on
skills/llm-externalizer-scan/SKILL.md:

  * TOC-coverage MINOR: my shortened Resources list matched only
    1/19 (then 4/19) of the H2 headings in usage-patterns.md.
    Restored the full 19-item TOC using the EXACT heading
    strings from references/usage-patterns.md.
  * 5000-char MAJOR (side-effect of the TOC restore): offset
    by trimming the `.md files` rule block + `Batching` and
    `answer_mode` paragraphs. Final size 5029 bytes (CPV counts
    ~4950 chars — under the 5000 cap).

Also addressed the shebang-without-executable warnings:

  * chmod +x scripts/validate_report.py
  * chmod +x scripts/validate_fixer_summary.py
  * chmod +x scripts/check_references.py

CPV result: CRITICAL=0 MAJOR=0 MINOR=0 NIT=0 WARNING=6 (all
remaining warnings are pre-existing / unrelated: mcp-server/
dir name, 7/8 and 18/19 TOC coverage on other skills, .config/
dotnet-tools.json backtick false-positive, uv.lock in .gitignore).
check_references.py --strict -> 0 broken, 0 dynamic.


## [4.1.2] - 2026-04-17

### Documentation

- Docs(scan-and-fix): fix wrong .md-scan examples + warn against LLM-as-validator

The previous examples suggested using the LLM scan for:

  - verifying skill descriptions match their tools
  - verifying argument-hints match actual command args

Those are deterministic structural checks — they belong to
CPV (claude-plugin-validation), `claude plugin validate .`, or
project-local AST/schema scripts. A validator runs them in
milliseconds, is reproducible, and cannot hallucinate. An LLM
doing the same work is orders of magnitude more expensive,
non-reproducible, and prone to false findings.

Replaced the two wrong examples with genuine LLM-appropriate
scans that only a semantic reader can do:

  - hardcoded model-id placeholders that need parameterizing
  - TODO/FIXME/XXX triage by urgency
  - pre-v4 API snippets that still ship in the docs
  - coverage of the --free flag's prompt-logging caveat

Added an explicit "DO NOT use this command for structural
validation" note pointing users to CPV, `claude plugin validate`,
and their own validation scripts.

Verified: check_references.py --strict -> 0 broken, 0 dynamic.


## [4.1.1] - 2026-04-17

### Fixed

- Fix(scan-and-fix): exclude .md files from auto-curation unless --instructions given

The default scan rubric audits source code — logic bugs, error
handling, security, resource leaks, broken references. None of
those apply to prose. A .md file (agent definition, SKILL.md,
command description, skill reference) has no control flow, no
exception paths, no resource lifecycle — feeding one to the
default rubric makes the LLM hallucinate findings or produce
empty reports. Both waste tokens.

Step 0 auto-curation now ALWAYS drops every .md file from the
list. The ONLY way to scan .md files is for the user to pass
an explicit --instructions <path> whose content tells the LLM
concretely what to check for, e.g.:

  * "Find references to the old command names /llm-externalizer:discover,
    /llm-externalizer:configure, /llm-externalizer:scan-and-fix,
    /llm-externalizer:search-existing-implementations and replace with
    the prefixed names /llm-externalizer:llm-externalizer-*."
  * "Find references to the old agent names llm-ext-fixer or
    llm-ext-reviewer and update to llm-externalizer-fixer / reviewer."
  * "Verify every skill description accurately reflects its tools."
  * "Check argument-hints in command frontmatters match the
    actual arguments the command parses."

When --instructions provides such a rubric, auto-curation includes
.md files in the relevant subtrees (agents/, commands/, skills/,
docs the user pointed at) and lets the scan run. Without
instructions, they stay excluded.

Verified: check_references.py --strict -> 31 refs, 0 broken, 0
dynamic.


## [4.1.0] - 2026-04-17

### Added

- Feat(scan-and-fix): auto-curate a file list when the user omits the target

When the user invokes /llm-externalizer:llm-externalizer-scan-and-fix
with no target-path and no --file-list, the orchestrator now runs a
Step 0 auto-discovery pass instead of asking blindly or defaulting
to cwd.

The agent:

  1. Finds the real codebase root via `git rev-parse --show-toplevel`
     from CLAUDE_PROJECT_DIR, or searches up to 3 levels deep for
     nested .git dirs. Handles the "parent workspace with no
     .gitignore, child repo with one" case automatically.
  2. Enumerates tracked files via `git ls-files` (so .gitignore is
     respected and nothing untracked is ever scanned).
  3. Filters the list using agent judgment — drops docs, examples,
     samples, fixtures, templates, snapshots, build output, lock
     files, binary assets, vendored deps, *_dev folders, runtime
     artifacts. Keeps real source code and plugin-authored
     markdown (agents, commands, skills).
  4. Writes /tmp/llm-externalizer-scan-and-fix.<TS>.auto-filelist.txt.
  5. Shows the user the curated list (root, count, breakdown,
     samples, excluded samples) and asks for confirmation.
  6. On confirm, continues in --file-list mode. On cancel, aborts.
     On "edit", surfaces the tmp path for manual pruning.

Rationale: only an agent can tell docs from source, distinguish
samples from real examples, and locate the actual project repo
when the working dir is a workspace or a parent without a
.gitignore. A folder-path default can't do any of that.

Verified: check_references.py --strict -> 32 refs, 0 broken,
0 dynamic. (Caught one of my own prose false-positives — a
comma-list rendered as one path — during the commit dance; fixed
by punctuating.)


## [4.0.2] - 2026-04-17

### Fixed

- Fix(scan-and-fix): require explicit target, never silently default to cwd

When the user invoked /llm-externalizer:llm-externalizer-scan-and-fix
with no arguments, the old spec silently defaulted to `.` — which in
real setups is often the parent of a plugin/workspace and contains
dev/runtime folders (`*_dev/`, `reports/`, `.rechecker/`, generated
output, sibling projects). Fixers WRITE to source files, so a wrong
default has real blast radius.

Changes to commands/llm-externalizer-scan-and-fix.md:

- Target-path is now REQUIRED (unless `--file-list` is supplied).
  The orchestrator must STOP and ask the user when no target is
  given. The command spec calls this out in both the Arguments
  section and Step 1.5.
- When the user asks for "the actual codebase", auto-detect via
  `git rev-parse --show-toplevel` (falling back to CLAUDE_PROJECT_DIR
  if not a git repo). This gives a safe whole-codebase scan.
- scan_folder calls now ALWAYS pass `exclude_dirs` with the standard
  *_dev folders from the project rules plus common runtime/artifact
  folders (reports, .rechecker, .mypy_cache, .ruff_cache, .serena,
  .claude, .venv, __pycache__). Combined with `use_gitignore: true`
  this keeps scans focused on source code even when the target is
  a wide codebase root.

Verified: check_references.py --strict -> 0 broken, 0 dynamic.


## [4.0.1] - 2026-04-17

### Documentation

- Docs: update stale command/agent name references after v4.0.0 rename

The v4.0.0 refactor renamed all commands and agents to carry the
llm-externalizer- prefix, but several in-tree .md files still
referenced the old short names. This commit sweeps every remaining
stale reference in the live tree.

README.md:
  - Features list:
      * `llm-ext-reviewer` -> `llm-externalizer-reviewer`
      * Added `llm-externalizer-fixer` agent to the feature list
      * "3 slash commands" -> "4 slash commands" with full prefixed names
  - Verify section: /llm-externalizer:discover -> llm-externalizer-discover
  - Configuration section: /llm-externalizer:configure -> llm-externalizer-configure
  - Commands table: all 4 commands listed with fully prefixed names,
    scan-and-fix and search-existing-implementations added
  - Plugin Structure tree: commands/ directory now lists all four
    renamed files plus an agents/ entry for the two agents

Skills:
  - skills/llm-externalizer-free-scan/SKILL.md:
    /llm-externalizer:discover -> llm-externalizer-discover
  - skills/llm-externalizer-or-model-info/SKILL.md: same
  - skills/llm-externalizer-or-model-info/references/errors.md:
    /llm-externalizer:configure and :discover both updated

Verified via `python3 scripts/check_references.py --strict`
(0 broken, 0 dynamic) and an exhaustive grep sweep across all .md /
.yml / .yaml / .json / .toml / .py files in the live tree — zero
remaining stale references.


## [4.0.0] - 2026-04-17

### Refactored

- Refactor!: unify all command/skill/agent names under llm-externalizer- prefix

Every user-facing entity in the plugin now uses the same prefix so
discovery, autocompletion, and global listings are consistent.

Commands (all renamed):
  configure                       -> llm-externalizer-configure
  discover                        -> llm-externalizer-discover
  scan-and-fix                    -> llm-externalizer-scan-and-fix
  search-existing-implementations -> llm-externalizer-search-existing-implementations

Agents (all renamed):
  llm-ext-fixer    -> llm-externalizer-fixer
  llm-ext-reviewer -> llm-externalizer-reviewer

Skills (already prefixed — unchanged):
  llm-externalizer-config, llm-externalizer-free-scan,
  llm-externalizer-or-model-info, llm-externalizer-scan,
  llm-externalizer-usage

Additional fixes:
  - llm-externalizer-usage skill gains an argument-hint so every
    command and skill now advertises autocompletion hints.
  - All internal cross-references updated (scan-and-fix command's
    subagent_type, fixer agent self-refs including the /tmp backup
    filename prefix, scan skill's agent: field, validate_fixer_summary
    docstring).
  - [FAILED]/[DONE] tag strings in the command bodies updated to
    match the new command names.

BREAKING CHANGE: slash commands have been renamed. Users must update
from /llm-externalizer:<short-name> to
/llm-externalizer:llm-externalizer-<short-name>. Agent subagent_type
strings in any external automation must update from llm-ext-fixer /
llm-ext-reviewer to llm-externalizer-fixer / llm-externalizer-reviewer.

Verified: check_references.py --strict -> 29 refs, 0 broken, 0 dynamic.
ruff check scripts/ -> clean.


## [3.16.0] - 2026-04-17

### Added

- Feat: add scan-and-fix command with parallel fixer agents and validation

New slash command /llm-externalizer:scan-and-fix orchestrates a full
codebase audit in three stages, with zero orchestrator-side report
reads:

  1. LLM Externalizer scan with answer_mode hardcoded to 0 (one report
     per input file) and output_dir hardcoded to
     \$CLAUDE_PROJECT_DIR/reports/llm-externalizer/.
  2. Parallel dispatch of the new llm-ext-fixer subagent (max 15
     concurrent) — one agent per report, no batching across files.
  3. Join via bundled Python script into a single final report whose
     filename is prefixed with a sortable local-timezone ISO-8601
     timestamp (%Y%m%dT%H%M%S%z).

Script-enforced reference validation (not agent-trusted):

  - scripts/validate_report.py — pre-flight: confirms scan-report
    File: reference resolves, line ranges are in-bounds, source
    stays inside --project-dir (path-traversal guard).
  - scripts/validate_fixer_summary.py — post-flight: confirms
    summary exists, non-empty, has the .fixer. tag, resolves inside
    --reports-dir, has the expected markdown structure.
  - scripts/join_fixer_reports.py — inlines those checks; rejected
    summaries recorded in the final-report header with reasons.
  - scripts/check_references.py — plugin-wide cross-file reference
    integrity tool for .md / .yml / .json / .toml. Static refs =
    errors; dynamic refs (containing \$, %, {{) = warnings only
    (--strict promotes them to errors).

Fixer agent hardening:

  - Tag changed from [FIXER] (shell character-class trap) to .fixer.
    (lowercase, dot-delimited, shell-safe).
  - Bash cp backup before any Edit — rollback is cp back, not LLM
    memory reconstruction.
  - Mandatory per-language linter matrix with Runner Fallback Chain:
    local binary -> project-runtime wrapper -> ephemeral remote
    runner (uvx / pipx run / bunx / pnpm dlx / npx --yes / go run).
    Silent skip only if no runner can invoke the tool.
  - Mandatory Bash argument quoting; path-traversal guard on every
    newly-discovered path.
  - Summary filename prefixed with sortable local-timezone
    ISO-8601 timestamp.


## [3.15.2] - 2026-04-15

### Testing

- Test(mcp): extract grouping helpers + 36 new tests (31 unit, 5 dispatch)

Motivation: the answer_mode=1 refactor added autoGroupByHeuristic() and
rewrote splitPerFileSections(), but neither had unit tests and the
helpers lived inside index.ts (which has top-level server.connect()
side effects that make direct import unsafe). This commit extracts the
helpers into a pure module and adds 36 tests.

1. New file: mcp-server/src/grouping.ts
   - Moved parseFileGroups, hasNamedGroups, autoGroupByHeuristic,
     splitPerFileSections, GROUP_HEADER_RE, GROUP_FOOTER_RE, FileGroup,
     and the private helpers (sanitizeGroupId, uniqueGroupId,
     statFileForGrouping, splitBucketBySize, splitBucketByBasenamePrefix)
     out of index.ts.
   - Module has zero side effects — only imports from node:fs and
     node:path — so tests can require it without booting the MCP server.
   - index.ts now imports from ./grouping.js.

2. New file: mcp-server/src/grouping.test.ts — 31 unit tests
   parseFileGroups (7):
     - empty input
     - unmarked paths → single unnamed group
     - single named group
     - multiple named groups preserve order
     - header closes previous group without explicit footer
     - files outside markers go into id=""
     - empty named groups dropped
   hasNamedGroups (3): all-empty, at least one named, empty array
   autoGroupByHeuristic (10, uses real tmp files on disk):
     - empty input
     - filters ---GROUP:id--- markers defensively
     - same-ext files in same dir → one group
     - different extensions in same dir → separate groups
     - different dirs with same ext → separate groups
     - nested subdirectories get their own group
     - stable deterministic ids across invocations
     - single file input
     - oversized bucket splits via FFD with -p{n} suffix
     - duplicate dir-name collision → unique _2 suffix
   splitPerFileSections (11):
     - empty input
     - no `## File:` headers → empty map
     - exact-path matching
     - suffix matching (dropped directory prefix)
     - basename matching
     - Windows CRLF line endings (trailing \r stripped by .trim())
     - backtick/quote decorations around path
     - missing sections omitted from map
     - duplicate header → first section kept
     - trailing `---` separator trimmed
     - single-file section without separator

3. New tests in index.test.ts — 5 answer_mode dispatch integration tests
   - chat mode 1: mixed-extension files route through auto-grouping
     without pre-LLM validation errors
   - code_task mode 1 + explicit ---GROUP:id--- markers: routes through
     the explicit grouped path
   - scan_folder mode 1: validates nonexistent folder BEFORE any LLM call
   - chat mode 2: regression guard for the single-merged-report path
   - search_existing_implementations mode 1: validates feature_description
     before the grouping step runs

4. vitest.config.ts — include grouping.test.ts in the default run.

Validation:
  - typecheck: ok
  - lint: 0 warnings
  - build: ok
  - npm test: 54/54 pass (31 unit + 23 integration, 18 pre-existing + 5 new)
  - grouping unit tests run in 6 ms

Note: the original index.ts was ~10k lines with scattered helper
definitions; extracting the grouping module also trims ~270 lines of
duplicated code from the main file.


## [3.15.1] - 2026-04-15

### Fixed

- Fix(mcp): review follow-ups — tautology, stale comments, pre-existing warning

Post-publish self-audit addressed 3 real issues:

1. check_against_specs had a trivially-tautological ternary
   `csFolderPath ? csFilePaths : csFilePaths` when deciding which path
   list to pass to autoGroupByHeuristic. folder_path is already normalized
   into csFilePaths upstream, so both branches were identical. Simplified
   to `autoGroupByHeuristic(csFilePaths)`.

2. search_existing_implementations had a stale code comment claiming
   "mode 1 — one report per batch" and "mode 0 — one report per batch
   (fall back to mode 1)" — both obsolete after the answer_mode redesign.
   Rewrote the comment to match the new semantics (mode 2 = SINGLE REPORT,
   mode 0 = ONE REPORT PER FILE via splitPerFileSections, mode 1 = ONE
   REPORT PER GROUP via autoGroupByHeuristic).

3. scan_folder mode 1 now carries an explicit comment documenting that
   grouping is POST-HOC (per-file LLM calls already ran, we cluster the
   finished reports) to contrast with chat/code_task/check_* which
   auto-group BEFORE calling the LLM.

4. Removed the pre-existing `_ciUseEnsemble` dead variable in the
   check_imports handler — it referenced currentBackend.type but was
   never used since check_imports calls chatCompletionJSON directly
   (no ensembleStreaming).

Self-audit also verified (false alarms from the ensemble review):
- batch_check / check_references / check_imports DO process mode 0/2
  non-grouped inputs correctly — the `if (effectivelyGrouped) { return }`
  block falls through to the existing non-grouped path below.
- search_existing_implementations mode 2 branch is still present at the
  expected location — the refactor only rewrote mode 1, not mode 2.
- splitPerFileSections handles trailing \r via .trim() on the captured
  path, so \r\n line endings already work.
- autoGroupByHeuristic GROUP_HEADER_RE/FOOTER_RE are defined at module
  level earlier in the file (not the helper's scope issue).
- chat/code_task `if (mode === 0 && !effectivelyGrouped)` is NOT
  redundant: it correctly skips the per-file path when markers are
  supplied with mode 0, matching pre-refactor behavior.

Validation: typecheck ok, lint 0 warnings, build ok, 18/18 tests pass.


## [3.15.0] - 2026-04-15

### Added

- Feat(mcp): redefine answer_mode — remove per-request mode, add per-group auto-grouping

Agents were being misled by the old "per-request" semantics of answer_mode=1
and the vague "per-file" wording of mode 0. A report from a real user:
agents assumed that avoiding mode 0 would let the LLM see the whole set of
input files at once, and repeatedly launched whole-codebase cross-file
searches via chat/code_task — wasting tokens for hours with no result.

This change rewrites the API and the docs so that:

1. answer_mode is clearly a DISK-OUTPUT control, not a batching control.
   The LLM always sees 1-5 files per request (FFD bin-packed or one group
   per request when ---GROUP:id--- markers are used).

2. In ensemble mode each file is reviewed by 3 different LLMs in parallel
   (3 responses per file). In free/local mode each file gets 1 response.

3. The old "per-request" meaning of mode 1 is GONE. New semantics:
   - 0 = ONE REPORT PER FILE  (unchanged — split by ## File: markers)
   - 1 = ONE REPORT PER GROUP (new — one .md per group)
   - 2 = SINGLE REPORT        (unchanged — everything merged)

4. Mode 1 auto-grouping: when the caller picks mode 1 without supplying
   ---GROUP:id--- markers, the server auto-clusters files by priority
   (subfolder > language/extension > namespace > shared basename >
   shared imports), capping each group at 1 MB via FFD sub-splitting.

Implementation:
- Added autoGroupByHeuristic() helper in index.ts (+ SizedFile struct,
  splitBucketBySize, splitBucketByBasenamePrefix).
- Rewrote BATCHING_NOTE and answerModeSchema.description using the
  structured NAME/DESCRIPTION/FORMAT/WHEN TO USE/ADVANTAGES/DISADVANTAGES
  format the user explicitly asked for.
- Spliced auto-grouping into the mode-1 branch of all multi-file handlers:
  chat, code_task, batch_check, check_references, check_imports,
  check_against_specs, scan_folder, search_existing_implementations.
- Removed the obsolete mode-1 per-batch save logic (batchOutputPaths,
  per-FFD-batch report persistence) from chat + code_task.
- scan_folder mode 1 now clusters the per-file results by auto-group and
  emits one merged report per group instead of collapsing to mode 2.
- search_existing_implementations mode 1 now splits batch responses by
  ## File: markers, re-groups files with autoGroupByHeuristic, and emits
  one merged report per auto-group (not per FFD batch).
- Updated the [DEPRECATED] batch_check handler to use auto-grouping when
  mode 1 is selected.
- Updated inline FILE GROUPING text in every tool description.

Docs touched:
- README.md — new answer_mode table with the full structured format and
  per-mode response examples.
- ~/.claude/rules/use-llm-externalizer.md — ensemble-vs-free clarification
  at the top, full structured mode block in the answer_mode section.
- skills/llm-externalizer-usage/SKILL.md — trimmed + new mode definitions.
- skills/llm-externalizer-usage/references/tool-reference.md — structured
  mode block replacing the old per-request wording, updated answer_mode
  row in the Advanced Parameters table.
- skills/llm-externalizer-scan/SKILL.md — ensemble note + new mode block.
- skills/llm-externalizer-scan/references/tool-reference.md +
  skills/llm-externalizer-free-scan/references/tool-reference.md —
  answer_mode row refreshed.
- commands/search-existing-implementations.md — new mode block describing
  what each mode writes.
- agents/llm-ext-reviewer.md — structured mode block.
- mcp-server/src/cli.ts — CLI help for `llm-externalizer search-existing`
  now documents all three modes and ensemble-vs-free behavior.

Validation: typecheck ok, lint 0, build ok, 18/18 tests pass.


## [3.14.2] - 2026-04-14

### Fixed

- Fix(sei): comprehensive review fixes for search_existing_implementations

Consolidates post-review fixes across the whole plugin surface after the
v3.14.0/v3.14.1 rollout. 7 BLOCKERS, 13 MAJORS, selected MINORS fixed.

=== BLOCKERS ===

B-1: ~/.claude/rules/use-llm-externalizer.md (user scope) had no mention
     of search_existing_implementations, the llm-ext-reviewer agent, the
     CLI subcommand, or userConfig. Also still listed batch_check as a
     deprecated-but-recommended option. Rewrote the Analysis tools table,
     added SEI-specific section with full example, added CLI section,
     added userConfig bridge auth section. Dropped batch_check row and
     NOTE blocks. Updated answer_mode section to document per-tool
     defaults instead of a one-size-fits-all "default: 0".

B-2: agents/llm-ext-reviewer.md's tools: allowlist did not include
     mcp__llm-externalizer__search_existing_implementations, which meant
     the plugin-shipped reviewer agent literally could not invoke the
     tool it was positioned for. Added it. Also added a new workflow
     bullet mentioning SEI as the first-choice tool for PR duplicate-
     check and "is this already done?" audits.

B-3: search_existing_implementations inputSchema was missing output_dir,
     free, recursive, follow_symlinks — the handler reads them from the
     outer scope variables (modelOverride, outputDir) but they were
     never declared in the tool contract, so strict MCP clients would
     filter them out. Rewrote the schema to spread ...folderSchemaProps
     and only override folder_path (to accept string|array) and max_files
     (to document the 10000 default instead of 2500). This fixes both
     B-3 (declare output_dir and free) and n-1 (schema duplication).

B-4: CLI callTool timeout was hardcoded at 900_000 ms (15 min). At
     ~10-60 s per ensemble batch × ~500 batches for a 10k-file scan,
     that's up to ~8h wall time — the 15 min timeout would always fire
     before completion. New CLI default: 4 hours. New flag: --timeout-
     hours <n> (fractional hours accepted, 0 disables).

B-5: README.md feature counts outdated — claimed "13 MCP tools", "2
     skills", "2 slash commands". Actual: 17 tools (9 analysis + 5
     utility + 3 or_model_info), 5 skills, 3 slash commands. The tools
     table was also missing search_existing_implementations and the
     or_model_info trio. Added a Feature bullet for the llm-ext-reviewer
     agent and the CLI subcommand. Dropped the batch_check "deprecated"
     row.

B-6: commands/search-existing-implementations.md had multiple stale
     claims:
     - "default 2500" (now 10000)
     - "returns one report per file" (now one merged report, mode 2)
     - --redact-regex listed but never plumbed through the CLI
     - Step 3 told Claude to shell out to git diff manually, duplicating
       the CLI's generateGitDiff logic
     Rewrote to prefer calling the MCP tool directly OR the CLI
     subcommand, with the --base/git-diff shell-out kept only as a
     fallback for when neither is available.

B-7: skills/llm-externalizer-usage/references/tool-reference.md tools
     table missing search_existing_implementations. Added a row with the
     full semantics description. Dropped batch_check row. Added or_model_*
     trio. Updated scan_folder default from 2 to 0 (the survey showed
     scan_folder actually defaults to 0, not 2).

=== MAJORS ===

M-1: The shared answerModeSchema.description said "Default: 0" globally,
     but tools have different defaults (scan_folder=0, chat/code_task/
     check_*=2, search_existing_implementations=2). Rewrote the shared
     description to document the per-tool defaults explicitly.

M-2: SEI's mode-2 branch was guarded by `seiMode === 2 && seiBatchOk.
     length > 0`, so an all-batches-failed run silently fell through to
     the mode-1 branch, which produced "0/N batches processed" with
     isError: false when failures were per-batch recoverable. Added an
     early return that catches zero-success irrespective of
     answer_mode and always returns isError: true with a detailed
     failure report including per-batch reasons and skipped files.

M-3: CLI set `answer_mode: 0` as its default (never omitted the field),
     which invisibly forced the handler into its mode-1 fallback path.
     Direct MCP callers got mode 2. Same tool, two defaults. Fixed by
     omitting answer_mode when --answer-mode is not supplied — server
     default (2) applies to both invocation paths.

M-4: printUsage said "0 = per-file reports (default), 1/2 = merged".
     Wrong on both counts — mode 1 is per-batch (not merged), and the
     CLI no longer defaults to 0. Rewrote the help text.

M-5, M-6: Symlink self-match leak. The handler excluded sourceFiles
     from the scan list via `fileSet.delete(sf)`, but walkDir pushes
     non-canonical display paths into the result list (it does
     realpathSync only for cycle detection). If a source file was
     reachable via a symlinked parent dir inside folder_path, the
     exclude missed it and the LLM saw the PR reference file as a scan
     target — producing a spurious self-match. Fix: collect both the
     user-supplied path AND realpathSync(path) into
     sourceFilesCanonical; post-walk, loop over fileSet and drop any
     entry whose non-canonical OR realpath-canonical form matches.

M-7: generateGitDiff used spawnSync with maxBuffer: 64MB. A PR touching
     a megabyte of lockfile changes exceeds 64 MB and gets truncated
     silently — the subsequent .trim() check then reports "diff vs BASE
     is empty". Raised buffer to 256 MB, added explicit ENOBUFS / signal
     detection with a clear error that tells the user to generate the
     diff manually and pass it via --diff.

M-9: skills/llm-externalizer-scan/SKILL.md instructed the forked
     llm-ext-reviewer agent on which tool to call (scan_folder /
     code_task / glob), but never mentioned
     search_existing_implementations. A natural "scan this codebase and
     tell me if this PR duplicates existing code" request couldn't
     reach the right tool. Added a bullet for duplicate check /
     "already done" audits.

M-13: .githooks/pre-push error message listed 8 check tools (npm ci,
      typecheck, lint, build, test, ruff, shellcheck, plugin.json, CPV)
      but was missing the v3.10.0 `claude plugin validate` gate. Added.

=== MINORS ===

m-3: skills/llm-externalizer-usage/SKILL.md:37 said "answer_mode: 0
     (default)" globally. Updated to document per-tool defaults.

m-4: Same file had a compare_files example using {git_repo, from_ref,
     to_ref} as top-level params, but these are file_pairs-mode fields.
     Replaced with the correct input_files_paths two-file form, and
     added a search_existing_implementations example.

m-8: commands/discover.md told users to run `python3 scripts/setup.py`
     if the service was offline. scripts/setup.py is a build step, not
     a recovery step — the MCP server is spawned by Claude Code from
     .mcp.json. Replaced with correct recovery instructions (restart
     Claude Code, check API key, check MCP logs, rebuild dist as last
     resort).

=== Intentional NO-OPs ===

- M-10 (free-scan skill using mcp__plugin_* prefix): false positive.
  The prefix has been verified to work in production in earlier
  sessions. Not changing without runtime evidence.
- m-1 (other tools not forwarding outputDir to saveResponse): existing
  bug in code_task, chat, and other unchanged tools. Not introduced by
  this session's changes; out of scope.

Verified:
- claude plugin validate . ✓
- CPV remote validation ✓ (CRITICAL=0 MAJOR=0 MINOR=0)
- npm run typecheck ✓
- npm run lint ✓
- npm run build ✓ (fully bundled dist/)
- npm test 18/18 ✓
- CLI smoke tests: missing description / missing --in / --help all clean


## [3.14.1] - 2026-04-14

### Fixed

- Fix(mcp): search_existing_implementations — FFD batching, exhaustive output, 10k-file support

Rewrote the handler to use the code_task mode 1/2 batched pipeline
instead of the scan_folder per-file pipeline. The earlier v3.14.0
implementation cloned scan_folder, which means every file was a
separate LLM call — 10k files = 10k calls, making the tool unusable
for the massive-codebase scenarios it was designed for.

New behavior:

1. FFD bin-packing via readAndGroupFiles()
   The server reads every matching file, packs them first-fit-
   decreasing into batches up to max_payload_kb (default 400 KB).
   For a 10k-file codebase this typically collapses into ~500 LLM
   calls (a ~20x reduction) while still fitting every file into
   the specialized multi-file prompt.

2. One ensembleStreaming() call per batch
   Each batch is sent as a single user message containing the base
   prompt + the per-file section marker + every file's fenced code
   block (generated by readAndGroupFiles). The LLM emits a section
   per file with per-file YES/NO answers.

3. Exhaustive per-file output — no 5-match cap
   The prompt now explicitly tells the LLM to report EVERY
   occurrence in every file, never truncate, never pick "most
   relevant first". The reviewer's use case is deleting every
   duplicate and leaving only the PR's new implementation, so they
   need to see every match.

4. answer_mode defaults changed
   - Mode 2 (default): single merged report with all batches
     concatenated and a header summarizing feature, folders,
     batches, reference files, and skipped files
   - Mode 1: one report per batch
   - Mode 0: falls back to mode 1 (per-file processing is
     meaningless for this tool — it would defeat batching)

5. max_files default raised from 2500 to 10000
   scan_folder's default was tuned for per-file scans; this tool
   is designed for massive-codebase reviews and defaults to a
   10k cap. Users can go higher with --max-files <n>.

6. output_dir now correctly forwarded to saveResponse()
   saveResponse's 5th argument (outputDir) was being omitted — the
   merged / per-batch reports now honor the user's --output-dir.

7. FFD skipped-files reporting
   readAndGroupFiles skips files exceeding the total payload
   budget. The handler now surfaces these in the merged report
   header AND the summary text, so users know which files were
   too big for their chosen max_payload_kb.

Advanced features confirmed working end-to-end:

  free         → modelOverride from resolveModelOverride() is now
                 passed directly to ensembleStreaming via its
                 options parameter. Same path as code_task. Free
                 routes through FREE_MODEL_ID.
  extensions   → walkDir auto-detects from source_files, or user
                 override via --extensions
  exclude_dirs → walkDir honors both built-in and user exclusions
  use_gitignore → walkDir via git ls-files (default true)
  max_files    → enforced in walkDir AND as a post-filter check
  scan_secrets → scanFilesForSecrets runs after walking
  redact_secrets → passed to readAndGroupFiles (applied per file
                   during block generation)
  redact_regex → passed to readAndGroupFiles (applied per file)
  answer_mode  → modes 1 and 2 both batched; mode 0 falls back
  max_payload_kb → controls FFD budget (default 400 KB)
  output_dir   → passed to saveResponse

Verified:
  - claude plugin validate . ✓
  - CPV remote validation ✓ (CRITICAL=0 MAJOR=0 MINOR=0)
  - npm run typecheck ✓
  - npm run lint ✓
  - npm run build ✓ (fully bundled dist/)
  - npm test 18/18 unit tests pass


## [3.14.0] - 2026-04-14

### Added

- Feat(mcp): add search_existing_implementations as a native MCP tool + CLI

What changed:
  - NEW MCP tool: search_existing_implementations (index.ts, ~320 lines).
    Walks the target folder(s), filters by language extension (auto-
    detected from source_files if not supplied), excludes source_files
    from the scan list to avoid self-match, builds the specialized
    yes/no prompt internally, and dispatches each file to the LLM
    pipeline (ensemble mode, auto-batching, per-file retry, circuit
    breaker). Output per file is terse: one line of NO, NO
    (self-reference), or YES symbol=<name> lines=<a-b> (max 5 per file).

  - NEW CLI subcommand: `llm-externalizer search-existing` (cli.ts).
    Spawns the MCP server via StdioClientTransport, calls the tool,
    prints the text result, exits. Supports all tool options plus
    `--base <ref>` (auto-generates the PR diff via
    `git diff <ref>...HEAD -- <src-files>`) and `--diff <path>` as an
    escape hatch. Auto-detects the base branch from origin/HEAD → main
    → master when neither flag is given and source files are provided.

  - Slash command /search-existing-implementations: rewritten as a
    thin 4824-char wrapper (was 13121 chars). Now just calls the MCP
    tool; all heavy logic lives in the server handler.

Inputs (all but one are optional):
  - feature_description  MANDATORY — drives the LLM prompt
  - folder_path          MANDATORY — single or list of codebase paths
  - source_files         OPTIONAL  — reference files; excluded from scan
  - diff_path            OPTIONAL  — narrows focus to new lines
  - extensions, exclude_dirs, max_files, scan_secrets, redact_secrets,
    answer_mode, redact_regex, use_gitignore, max_payload_kb  — same
    semantics as scan_folder

Why native MCP tool instead of slash-command-only:
  - Usable from any MCP client, not just Claude Code
  - Accessible from shell / CI via the CLI subcommand
  - Subagents can call it via mcp__ tool calls
  - The specialized yes/no prompt template lives server-side, so it
    doesn't need to be re-implemented in every caller
  - Consistent auto-batching, retry, and ensemble semantics with the
    other llm-externalizer tools

Tests:
  - index.test.ts: expected tools list now includes
    `search_existing_implementations` alphabetically between
    `scan_folder` and `set_settings`. All 18 unit tests pass.
  - CLI smoke-tested: missing description aborts with a clean error,
    missing --in aborts with a clean error, --help shows the new
    command with all flags documented.

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0), npm run typecheck ✓, npm run lint ✓,
npm run build ✓ (fully bundled dist/), npm test 18/18 ✓.


## [3.13.0] - 2026-04-14

### Added

- Feat(command): auto-generate PR diff via git in search-existing-implementations

The command now generates the PR diff itself instead of requiring
the user to pre-make and pass --diff <path>.

New resolution order for the diff (in Step 2.5):

Path A — user-supplied --diff <path>: escape hatch, used as-is.
  Useful outside a git checkout or for curated patches.

Path B — user-supplied --base <ref>: command runs
  `git diff <ref>...HEAD -- <source-files>` using the three-dot
  merge-base form (matches what GitHub/GitLab show on a PR),
  restricted to the source files so only the relevant changes are
  included. Writes to a fresh /tmp/llm-ext-search-existing-diff-
  <ts>.patch and passes that path to code_task.

Path C — neither flag: auto-detect the base branch. Tries
  `git symbolic-ref --short refs/remotes/origin/HEAD` first
  (authoritative default-branch signal), then main, then master.
  Aborts with a helpful message if none resolve or cwd is not a
  git working tree.

Aborts cleanly on:
  - git diff failure (ref missing, bad working tree)
  - empty diff (no changes vs base for the source files)
  - not inside a git repo and no --diff given
  - auto-detection found no usable base branch

The --diff flag remains an escape hatch for edge cases. Previously
it was the ONLY way to supply the diff; the spec required users to
manually generate and save the patch before calling the command —
now they just run `/search-existing-implementations "desc" src.py
--in /path/to/codebase` and the command handles the rest.

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0).


## [3.12.1] - 2026-04-14

### Refactored

- Refactor(command): tighten search-existing-implementations spec

Revisions after user feedback on the v3.12.0 draft:

Inputs — all four are now MANDATORY:
  1. Quoted feature description (first $ARGUMENTS token)
  2. Source file(s) (positional, 1+)
  3. --diff <path> (now mandatory, was optional)
  4. --in <path> (now mandatory, was optional; defaulted to cwd)
     Supports multiple paths via repeated flag or comma-separated
     list. Each entry can be a directory (walked) or a single file

LLM output — drastically simplified:
  - One line per finding: `NO` or `YES symbol=<name> lines=<a-b>`
  - Max 5 YES lines per file if multiple matches
  - Special: `NO (self-reference)` when the LLM recognises the PR
    file itself
  - No STATUS categories (EXISTS/SIMILAR/HELPER dropped)
  - No RATIONALE field, no REUSE_PATH field
  - Ensemble mode trusted for false-positive filtering —
    disagreements between the 3 models are the reviewer's signal

Forwarded options (same as every other LLM Externalizer command):
  --free           → pass through to code_task as free: true
  --output-dir     → pass through as output_dir
  --exclude-dirs   → applied during target filtering
  --redact-regex   → pass through as redact_regex

Architecture (unchanged):
  - instructions_files_paths carries sources + diff (server reads
    them once, orchestrator never loads file contents)
  - input_files_paths is the filtered codebase list (Glob + dedupe
    + exclude source files + exclude non-code dirs)
  - Auto-batching by the server keeps request count low inside
    max_payload_kb
  - answer_mode: 0 → one .md report per input file, each report
    has one section per ensemble model

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0).


## [3.12.0] - 2026-04-14

### Added

- Feat(command): add search-existing-implementations

New slash command for PR reviewers: given a new feature from a PR,
scan the rest of the codebase in the same language to find existing
implementations that already solve the same problem — avoiding
duplicate code.

Takes:
  - MANDATORY: a quoted feature description (e.g. "async retry with
    exponential backoff"). Used directly in the specialized LLM
    prompt so the model knows what to look for even when source
    files contain many unrelated functions
  - MANDATORY: one or more source file paths (the PR files with the
    new implementation). These become reference context passed to
    the LLM — NOT targets to scan
  - OPTIONAL --folder <path>: limit the search subtree (default cwd)
  - OPTIONAL --diff <path>: unified-diff file to narrow the LLM's
    focus to the exact new lines

The command delegates per-file comparison to
mcp__llm-externalizer__code_task with:
  - instructions: specialized prompt with the feature description
  - instructions_files_paths: source files + diff (shipped as
    reference context by the server — orchestrator never reads
    the source content)
  - input_files_paths: every matching-language file in the target
    folder, minus the source files themselves, minus common
    non-code dirs
  - answer_mode: 0 (one report per file)
  - max_retries: 3

Each report classifies the file's relationship to the PR feature:
EXISTS / SIMILAR / HELPER / NONE, with symbol name, line range,
rationale, and reuse path. The command returns ONLY the list of
report file paths — the verbose per-file analysis never touches
the orchestrator context window.

Verified: claude plugin validate . ✓, CPV remote validation ✓
(CRITICAL=0 MAJOR=0 MINOR=0).


## [3.11.0] - 2026-04-12

### Added

- Feat(plugin): adopt userConfig, ship reviewer agent, fork scan to subagent

Three plugin-spec features deferred from v3.10.0 are now implemented
(marketplace source intentionally not changed):

1. userConfig for OPENROUTER_API_KEY (plugin.json + config.ts)
   - plugin.json: declare openrouter_api_key with type=string,
     sensitive=true, title, description; Claude Code prompts on
     install and stores in system keychain
   - config.ts: USER_CONFIG_ENV_MAP transparently maps the auto-
     exported CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY env var into
     the canonical OPENROUTER_API_KEY name. userConfig wins over
     shell env when both are set; existing shell-env-only setups
     keep working unchanged

2. agents/llm-ext-reviewer.md (new)
   - Plugin-shipped Haiku-class agent for fast code reviews
   - Restricted tools allowlist: Read, Glob, Grep, Bash + read-only
     llm-externalizer MCP tools (no Write/Edit)
   - Returns ONLY report file paths to the orchestrator — never
     reads or summarizes report contents
   - Default rubric: bugs, error handling gaps, security, resource
     leaks, broken references

3. llm-externalizer-scan skill: context: fork + agent: llm-ext-reviewer
   - Skill body rewritten to a self-contained task prompt using
     $ARGUMENTS — runs in the reviewer's isolated subagent context
   - Verbose scan output stays out of the orchestrator's context
     window; only the final report path comes back

Verified:
- claude plugin validate . passes
- npm test: 18/18 unit tests pass
- npm run build: dist rebuilt cleanly with the config.ts changes


### Fixed

- Fix(skill): restore CPV-required sections in scan skill body

The v3.11.0 context: fork rewrite stripped all 7 sections required
by CPV strict mode (Overview, Prerequisites, Instructions, Output,
Error Handling, Examples, Resources), causing 7 MAJOR validation
errors that blocked publish.

Fix: rewrite the scan SKILL.md so it satisfies BOTH constraints:
- All 7 CPV-required section headings present (Anthropic strict
  skill structure)
- Body is still a self-contained task prompt for the forked
  llm-ext-reviewer subagent — the lead-in paragraph and the
  Instructions section give clear actionable steps using $ARGUMENTS

Also:
- Compressed body to 4358 chars (under CPV's 5000-char ceiling
  for progressive disclosure)
- Restored "Copy this checklist and track your progress" phrase
  required by CPV checklist convention
- Trimmed Examples to 2 entries and Error Handling table to 5 rows

Verified: CPV remote validation now reports CRITICAL=0 MAJOR=0
MINOR=0 (5 pre-existing WARNINGs remain, all structural and
non-blocking).


## [3.10.0] - 2026-04-12

### Added

- Feat(plugin): align with Claude Code v2.1.101 spec

Plugin compliance updates against the current Claude Code plugin
spec (plugins-reference.md, skills.md) as of 2026-04-10:

- skills/*/SKILL.md: remove non-spec `version:` field (not part of
  skill frontmatter — versioning lives in plugin.json); present in
  all 5 skills and silently ignored today
- skills/*/SKILL.md: add `effort:` frontmatter (v2.1.80) — `low` for
  or-model-info, `medium` for scan/free-scan/config/usage
- skills/*/SKILL.md: add `argument-hint:` to 4 skills that accept
  arguments (config, free-scan, or-model-info, scan) for better UX
- scripts/publish.py: add `claude plugin validate .` as mandatory
  check #9, add `claude` to REQUIRED_TOOLS list — catches future
  schema drift automatically

Deferred (design discussion needed): userConfig keychain for
OPENROUTER_API_KEY, git-subdir marketplace source, dedicated
code-review agent, context:fork on scan skill.


## [3.9.85] - 2026-04-10

### Fixed

- Fix(publish): use process ancestry instead of lock file for push gate

The pre-push hook now walks the parent PID chain via `ps` to verify
that scripts/publish.py is an ancestor of the git push process.
This replaces the .publish.lock file which was trivially spoofable
(anyone could `touch .publish.lock` before `git push`).

- .githooks/pre-push: rewritten with walk_ancestry() that resolves
  each ancestor's argv tokens and compares to the canonical
  scripts/publish.py path
- scripts/publish.py: removed all lock file write/cleanup logic,
  updated docstrings to document ancestry-based verification
- core.hooksPath set to .githooks (was defaulting to .git/hooks
  which had a broken symlink)


## [3.9.84] - 2026-04-10

### Changed

- Cliff.toml: use raw_message to keep full commit body in changelog

The previous template used {{ commit.message }} which, with
conventional_commits=true, drops the full body when git-cliff
successfully parses a 'scope: subject' format — commit.message
becomes only the subject-after-colon, and commit.body only
contains the first paragraph (up to the first blank line).

Result: commits like 'publish.py: strict mode...' had their
entire multi-line body silently dropped from the changelog and
release notes. Commits like 'Separate retry budget...' (no colon)
kept the body because the conventional parser failed and
commit.message fell back to the raw text.

Fix: template now uses {{ commit.raw_message }}, which returns
the unparsed full commit text (subject + body + trailers) directly
from git. conventional_commits=true is still enabled so the
commit_parsers keep classifying commits into groups (Added /
Fixed / Changed / etc), but the displayed content is always the
full raw message regardless of parse success.

Regenerated CHANGELOG.md for v3.9.83 so the entry now has the
full 6-item change list, not just the subject. GitHub release
notes for v3.9.83 updated to match.


### Refactored

- Refactor(publish): validate first, auto-detect version via git-cliff

User directive: 'first lint, test, validate. then bump/git-cliff/
commit.' Reorganized publish.py to follow that exact workflow,
adapting the reference script the user provided.

New flow:

  1. Pre-flight      — working tree clean
  2. Validate        — run_checks() + run_cpv_validation() (MOVED UP)
  3. Determine ver.  — git-cliff --bumped-version (default) or flag
  4. Generate CL.    — git-cliff regenerates full CHANGELOG.md
  5. Sync version    — plugin.json, package.json, server.json, index.ts
  6. Rebuild dist    — npm run build with the new version
  7. README badges   — shields.io badge URLs
  8. Commit          — 'chore(release): vX.Y.Z' (conventional format)
  9. Tag             — git tag -a vX.Y.Z
  10. Push           — git push --follow-tags
  11. GitHub release — gh release create

Key changes from the old flow:

- VALIDATION NOW RUNS FIRST. Previously checks ran AFTER planning
  the version bump (step 2 was validate, but step 1 was 'plan
  version'). New order makes more sense: validate, THEN decide what
  version to release.

- AUTO-DETECTED VERSION VIA GIT-CLIFF. Default behavior is now
  `git-cliff --bumped-version`, which parses conventional commits
  since the last tag to decide patch/minor/major. Manual override
  flags --patch/--minor/--major/--set still work and take
  precedence over the auto-detection.

  New helper: determine_next_version(args, current).
  New helper: git_cliff_bumped_version() — wraps the CLI call.

- CONVENTIONAL COMMIT MESSAGE. The release commit is now
  'chore(release): vX.Y.Z' instead of 'Release vX.Y.Z'. Matches
  conventional commits format, and cliff.toml already has a
  commit_parsers rule to skip '^chore\\(release\\)' from future
  changelog output.

- DRY-RUN NOW EXITS AFTER VERSION DETERMINATION. Dry-run still runs
  the full check suite (validation is mandatory even in dry-run),
  then shows what WOULD be published with the auto-detected or
  flag-specified version, then exits without any file mutations.


## [3.9.83] - 2026-04-10

### Changed

- Publish.py: strict mode — zero-skip validation gates

User directive: 'make so that it will be IMPOSSIBLE to skip any of
the checks, from linting to testing to validation. everything must
pass with 0 error before committing and pushing! NO EXCEPTIONS!'

Changes:

1. New require_tools() gate — runs at the top of main(). Verifies
   every required tool is on PATH: git, node, npm, npx, gh, uvx,
   ruff, shellcheck, git-cliff. Dies with a clear install hint per
   missing tool. Runs for ALL modes (--dry-run, --check-only,
   normal publish) because all three need the full check suite.

   The old logic only required `gh` for non-check-only mode, and
   let ruff / shellcheck / uvx be conditional — that's gone.

2. run_checks() rewritten in strict mode — no conditional SKIP
   paths. Every check is mandatory:

      1. npm ci         (clean dep install, always — not conditional)
      2. npm run typecheck  (tsc --noEmit)
      3. npm run lint       (eslint --max-warnings 0)
      4. npm run build      (full esbuild bundle)
      5. npm test           (vitest run — see note below)
      6. ruff check scripts/
      7. shellcheck all *.sh in main tree
      8. plugin.json JSON parse

   Tests and full build are NEW additions — previously absent. If
   any check fails, returns False and the caller aborts.

3. run_cpv_validation() extracted into its own helper. Same
   behavior as before — CPV remote validation with CRITICAL=MAJOR=0
   required — but now called from both --check-only and normal
   publish paths via a single function instead of duplicated
   inline blocks.

4. --dry-run now runs the full check suite BEFORE planning the
   version bump. Previously dry-run exited early after the version
   plan step, skipping all validation. That was a bypass path —
   fixed: dry-run shows what WOULD be published, which only makes
   sense if the checks pass. If they don't pass, there's nothing
   to preview.

5. mcp-server/package.json — test script split into three:
     • 'test'      → runs unit tests only (excludes src/live*.test.ts)
     • 'test:live' → runs the live integration tests manually
     • 'test:all'  → runs everything
   Live tests depend on a running LLM backend and have environmental
   state that varies per run — they shouldn't gate a publish. The
   deterministic unit tests in index.test.ts DO gate publishing.

6. index.test.ts listTools expected array updated to match current
   tool set — added check_against_specs, or_model_info,
   or_model_info_table, or_model_info_json, reset (these were added
   in recent releases but the test was never updated to match).

Verified: `python3 scripts/publish.py --check-only` now runs 9
mandatory gates and passes all of them. Any failure in any gate
aborts publish with a clear per-gate error log in reports_dev/publish/.


## [3.9.82] - 2026-04-10

### Changed

- Separate retry budget for empty responses (15 attempts, 2s fixed wait)

OpenRouter's free-tier models (notably Nemotron 3 Super :free) have
~96% per-request reliability due to cold-start and scaling behavior
documented in their error reference as 'no content generated'. The
recommended workaround is a retry mechanism, but our previous
MAX_TRUNCATION_RETRIES = 3 cap gave up too early for this failure
mode — most empty-response files would succeed on attempt 4 or 5.

New retry loop structure:

- Generic failures (network errors, finishReason=error, unknown
  values): MAX_TRUNCATION_RETRIES = 3 attempts (unchanged)
- Empty responses on OpenRouter (finishReason=empty/stop with zero
  content): MAX_EMPTY_RESPONSE_RETRIES = 15 attempts with a fixed
  2-second wait between each

Fixed interval, not exponential backoff. Empty responses are
cold-start / scaling signals, not rate-limit signals — exponential
backoff would be the wrong primitive (it makes us wait longer
precisely when the provider has had more time to warm up). A
constant 2s gap just gives the upstream endpoint a moment to finish
whatever scaling it was doing, without piling requests on top of
each other.

Two counters (genericAttempts and emptyAttempts) track each budget
separately so a mix of transient network errors and empty responses
doesn't exhaust either budget prematurely. The retry loop now uses
`while (true)` with dynamic cap selection instead of a fixed-range
for loop.

The reasoning-cache escalation (xhigh -> high -> none) still
happens on empty responses as before, so a model that can't
tolerate xhigh reasoning will step down over the first few retries
and the remaining attempts run with less aggressive settings.

Service-health cooldown still fires if the global consecutive
failure threshold is hit, so a persistent provider outage eventually
aborts with a proper error instead of looping forever. That's the
hard safety net.


## [3.9.81] - 2026-04-10

### Changed

- Or_model_info skill: don't reprint — trust the Bash tool output pane

User directive: let the Bash tool output stand alone. The tool pane
renders ANSI colors natively; if the output is collapsed behind a
'+N lines' fold, the user expands it with ctrl+o themselves. No
reprinting, no paraphrase, no summary.

The assistant should run the CLI and stop. Only add commentary when
the user asks an explicit follow-up question beyond 'show me the
info' (like 'which provider is cheapest?' or 'does it support
reasoning?').

This resolves the long thread about ANSI surviving markdown
reprints — it doesn't, and Claude Code's markdown renderer strips
ESC bytes in every form (fenced, unfenced, with any language tag).
The only rendering pipeline that processes ANSI is the Bash tool
output pane itself, so we just let that pane do its job.


## [3.9.80] - 2026-04-10

### Changed

- Or_model_info: emoji quality markers survive markdown reprint

Claude Code's markdown renderer strips the ESC byte (0x1B) from text
content but leaves the trailing '[96m'-style codes as literal garbage.
Verified across every wrapper form (fenced code blocks with any
language tag, bare text, raw bytes). ANSI colors only render in the
Bash tool output pane, which collapses long output behind a fold.

Since ANSI cannot survive reprinting, every color-classified value
in the table now also carries an emoji prefix:

  🟢 excellent / good / yes / free
  🟡 borderline
  🔴 poor / no
  ⚪ neutral

Applied to: capability flags (reasoning, tools, structured output,
implicit caching), pricing (free highlight), uptime (all three
windows), latency percentiles, throughput percentiles, discount.

Emoji render natively in markdown, so the quality-at-a-glance
information is now preserved when the output is reprinted in the
chat. Terminal users running the CLI still see both — ANSI colors
on the text plus emoji prefix — so neither audience loses info.

Example row:
  │ Reasoning   │ 🟢 yes       │
  │ Uptime (30m)│ 🟢 96.4%     │
  │ Latency p99 │ 🔴 104226 ms │
  │ Throughput  │ 🟢 50 tok/s  │
  │ Prompt price│ 🟢 free      │

New helpers in or-model-info.ts:
  QualityLevel type
  qualityEmoji(level) — maps level to emoji
  uptimeLevel / latencyLevel / throughputLevel / priceLevel
    — mirror the ANSI classify* functions but return levels,
      so both emoji and ANSI color pick from the same judgment

Shared between the markdown formatter (formatModelInfoMarkdown)
and the ANSI table renderer (formatModelInfoTable).


## [3.9.79] - 2026-04-10

### Changed

- Or_model_info: audit fixes — timeout, validation, error codes, paths

Systematic review pass across or-model-info.ts, index.ts, cli.ts.
Found and fixed the following issues:

1. HANG RISK: fetchOpenRouterModelInfo used raw fetch() with no
   timeout. If OpenRouter hung, the CLI or MCP tool would wait
   forever. Now uses AbortController with a 15s default timeout.
   Surfaces AbortError as 'OpenRouter request timed out after 15s'
   so the user knows it wasn't a transient failure.

2. PATH TRAVERSAL: model id was interpolated raw into the URL
   /v1/models/{id}/endpoints. An adversarial id like '../../etc/...'
   would escape the intended path. Added isValidOpenRouterModelId()
   that enforces '<vendor>/<model>[:variant]' with a strict regex
   and rejects '..' / '//' / length > 200. Validation runs before
   URL construction.

3. ERROR CODES: only 404 had a friendly error message. Now covers
   400 / 401 / 402 / 403 / 404 / 408 / 429 / 502 / 503 / 504 with
   specific user-facing text per status, matching the OpenRouter
   error reference we saved in docs/openrouter/errors-and-debugging.md.
   Applied to both the MCP tool handler and the CLI.

4. FILE PATH SAFETY (MCP): or_model_info_json accepted any file_path
   and silently resolved relative paths against process.cwd(), which
   could surprise callers. MCP tool now REQUIRES absolute paths and
   returns a clear error otherwise. CLI stays permissive (relative
   paths resolve against cwd, matching shell semantics) but rejects
   empty strings.

5. REASONING FLAG: the capability row checked only
   params.has('reasoning'), which is the reasoning.effort config
   field. Some models expose 'include_reasoning' as a separate flag
   without the effort field. The check now accepts either — semantic
   correctness: 'does this model do reasoning at all?'.

6. UNREACHABLE CODE WARNINGS: switch/case with die() branches
   triggered no-fallthrough warnings because die() returns never.
   Rewrote as an if-chain for the CLI error branch. Cleaner anyway.

Imports added: isAbsolute from node:path (both index.ts and cli.ts).

Verified end-to-end:
  • Valid model → table renders
  • Path traversal ('../../etc/passwd') → rejected with clear error
  • 404 model → friendly error message with remediation hint
  • --json /tmp/file.json → writes to absolute path
  • --json rel.json (CLI) → resolves against cwd (shell-like)

CPV: CRITICAL=0 MAJOR=0 MINOR=0.


## [3.9.78] - 2026-04-10

### Changed

- Add or_model_info_json MCP tool with optional file_path

Parity between the CLI and the MCP surface. The CLI gained
`--json [file]` in v3.9.77; this release exposes the same feature
as a dedicated MCP tool.

New tool:
  or_model_info_json
    input:
      model: string (required) — exact OpenRouter model id
      file_path: string (optional) — absolute path to write JSON to

Behavior:

  • file_path omitted   → returns pretty JSON inline in the tool result
  • file_path provided  → writes JSON to the resolved absolute path
                          and returns only 'JSON written to <path>',
                          saving caller context tokens when the JSON
                          is large or when it will be consumed by
                          another tool instead of the assistant.

The handler for or_model_info / or_model_info_table / or_model_info_json
is now a single case block that dispatches on `name`. The fetch +
error-handling path is shared; only the final formatting step branches.

Imports: formatModelInfoJson from ./or-model-info.js. writeFileSync
and resolve are already imported at the top of index.ts.

Three OpenRouter model info tools on the MCP now:

  • or_model_info        — markdown (pipe-delimited table)
  • or_model_info_table  — ANSI-colored Unicode-bordered table
  • or_model_info_json   — raw JSON (stdout or file)


## [3.9.77] - 2026-04-10

### Changed

- Or_model_info: proper markdown tables + --json [file] option

Two output format additions driven by real-world use:

1. --markdown now produces a pipe-delimited markdown table instead
   of a bulleted list. Markdown tables already have borders via
   |---| separators in any markdown viewer, so the old bulleted
   form was wasting that structure. Emits one ## section per
   endpoint with a proper | Field | Value | table, plus a
   bulleted list of supported_parameters below the table
   (multi-value cells don't render cleanly in markdown tables).
   Pipe characters inside cell values are backslash-escaped.

2. --json [filepath] for the raw OpenRouter response data.
   Without an argument, prints pretty JSON to stdout. With an
   argument, treats it as a filepath and writes the JSON there,
   echoing 'JSON written to <path>' on stdout so scripts can
   parse the confirmation. Uses the existing parseFlags
   --key value handling; '--json' alone → flags.json='true'
   (stdout), '--json foo.json' → flags.json='foo.json' (file).

New helper in or-model-info.ts:
  - formatModelInfoJson(data) — JSON.stringify with 2-space indent
  - mdCell(s) — markdown-table cell escape (| → \|)
  - formatModelInfoMarkdown — full rewrite to pipe-delimited tables

CLI help updated:
  llm-externalizer model-info <model-id> [--markdown | --json [file]] [--no-color]

Skill SKILL.md lists --json / --raw as a recognized passthrough
flag and shows the file-output variant in the Examples section.


## [3.9.76] - 2026-04-10

### Changed

- Or_model_info skill: optional --no-color / --markdown passthrough

The skill now scans the user's args for optional flags and forwards
them to the underlying CLI invocation:

- --no-color / --nocolor / --bw / --mono → CLI --no-color
  For users with monochrome terminals or log captures where ANSI
  escape sequences would appear as garbage.
- --markdown / --plain → CLI --markdown
  For users who want the plain markdown output instead of the
  Unicode-bordered table (useful for piping into another tool,
  or for very narrow terminals where the table wraps).

Default behavior unchanged: no flags → colored ANSI table, which
Claude Code's terminal UI renders correctly inside fenced code
blocks in the chat transcript.

Invocation examples:
  /llm-externalizer:llm-externalizer-or-model-info <model-id>
  /llm-externalizer:llm-externalizer-or-model-info <model-id> --no-color
  /llm-externalizer:llm-externalizer-or-model-info <model-id> --markdown


## [3.9.75] - 2026-04-10

### Changed

- Or_model_info skill: keep ANSI colors, revert --no-color default

Claude Code's terminal UI renders ANSI escape codes in Bash tool
output — the user saw the colorized borders in earlier runs and
complained they were dim (proving the codes were being interpreted,
not shown as literal garbage).

Previous release switched the skill to --no-color based on a wrong
assumption that ANSI codes would appear as raw escape sequences in
the rendered transcript. They don't. Reverting: the skill now runs
the CLI with colors ON and reprints the output verbatim.

Users viewing the rendered transcript see bright cyan borders, green
capability flags, yellow/red latency percentiles, and the footer
legend color key as intended.


## [3.9.74] - 2026-04-10

### Changed

- Or_model_info skill: reprint CLI stdout verbatim + use --no-color

Two fixes to the skill instructions:

1. Claude Code collapses long Bash tool output behind a
   '+N lines (ctrl+o to expand)' fold, so the rich table rendered
   by the CLI was never actually visible to the user — they only
   saw the first few lines inside the collapsed tool result. The
   skill now explicitly instructs the assistant to COPY THE ENTIRE
   CLI STDOUT VERBATIM into its response as a fenced code block.
   The table must appear in the rendered transcript, not behind a
   fold.

2. Default to --no-color. ANSI escape codes get stripped when the
   output is reprinted inside a code block anyway, and they add
   noise. The Unicode borders, row separators, column alignment,
   and footer legend all survive without color. The --no-color
   variant is strictly better for the skill's use case. Users who
   want the colored version directly in their terminal can run the
   CLI themselves without --no-color.

Also shrunk the Prerequisites section from 6 lines to 2 to keep
SKILL.md under the 5000-char CPV strict-mode limit.


## [3.9.73] - 2026-04-10

### Changed

- Or_model_info: bright borders + row separators + no-paraphrase skill

Three issues reported from a real skill invocation:

1. The skill paraphrased the CLI output instead of showing it verbatim.
   The whole point of the rich ANSI-colored table is that it's the
   final user-facing format — summarizing it in plain text defeats
   the purpose. Updated the SKILL.md checklist item 4 to explicitly
   say 'do NOT paraphrase, summarize, or rewrite' the CLI output.
   The skill now just runs the command and shows the result.

2. The table had no row separators between body rows — everything
   ran together in a dense block. Each logical row now gets a
   ├─┼─┤ separator after it. Multi-line cells (supported_parameters)
   render as a group with no internal separator — the label appears
   only on the first line, continuation rows have an empty label
   column, and one separator closes the whole group.

3. The border color was ANSI.dim, which renders nearly invisible on
   most terminals (especially with low-contrast themes). All borders
   — the header box ┏━┓ and the main table ┌─┐ ├─┤ └─┘ — are now
   bright cyan (ANSI.bcyan, SGR code 96). Matches the header
   highlight color so the whole table reads as a single unit.

Also shrunk SKILL.md from 5260 to 4719 chars to stay under CPV's
5000-char strict-mode limit.


## [3.9.72] - 2026-04-10

### Changed

- Or_model_info: supported_parameters as multi-line column inside the table

The supported_parameters list was previously printed after the main
table as a 3-column horizontal grid. That packed multiple values
side-by-side on each line, which is confusing to scan.

Now rendered as a single multi-line cell inside the main table:

  │ Supported params (10)    │ ✓ include_reasoning                    │
  │                          │ ✓ max_tokens                           │
  │                          │ ✓ reasoning                            │
  │                          │ ✓ response_format                      │
  │                          │ ...                                    │

One value per line, label only on the first line, continuation rows
have an empty label column. Everything stays inside the Unicode
border, and the column width calculation accounts for the longest
value across all the array lines.

Row type updated to [string, string | string[]] — arrays are treated
as multi-line cells, strings as single-line cells. The rendering loop
walks the values array and emits a continuation row for each entry
after the first.


## [3.9.71] - 2026-04-10

### Changed

- Or_model_info: dedicated capability rows + null uptime crash fix

New capability rows at the top of each endpoint table, derived from
supported_parameters — these answer the 'what can I configure on
this model?' question at a glance without scrolling the full grid:

- Reasoning         yes/no (reasoning in supported_parameters)
- Tool calling      yes/no (tools in supported_parameters)
- Structured output yes/no (structured_outputs or response_format)

Implicit caching stays as a dedicated row (it comes from a separate
field, not supported_parameters).

Also fixed a crash on models like meta-llama/llama-3.3-70b-instruct
where some endpoints (e.g. DeepInfra) return uptime_last_5m/30m/1d
as null instead of a number. The old code used `!== undefined` as
the guard, which let null through and crashed on .toFixed(1).
Switched to typeof === 'number' check and updated the interface
to reflect number | null | undefined.

Max completion and max prompt rows now include the 'tokens' suffix
for consistency with the context length row.

Verified on:
- google/gemini-2.5-flash (reasoning yes, tools yes, 3 endpoints)
- nvidia/nemotron-3-super-120b-a12b:free (reasoning yes)
- meta-llama/llama-3.3-70b-instruct (reasoning no, 17 endpoints,
  some with null uptime — renders cleanly now)


## [3.9.70] - 2026-04-10

### Changed

- Or_model_info: dynamic percentile parsing + header box overflow fix

Percentiles are now discovered dynamically from the response object
instead of being hardcoded to p50/p75/p90/p99. Any pXX or pXX.X key
OpenRouter adds in the future — p25, p95, p99.9, p99.99 — is parsed,
sorted numerically, and rendered with its own row and color. Also
handles future percentile renames gracefully: we filter to keys
matching /^p\\d+(?:\\.\\d+)?$/, sort by the numeric part, emit one
row per entry.

New exports in or-model-info.ts:

- ModelEndpointPercentiles — Record<string, number | undefined>
  (replaces the closed p50/p75/p90/p99 interface)
- sortedPercentiles(obj) — returns [{key, value, numeric}] sorted
  by numeric percentile, filtering non-percentile keys
- percentileAnnotation(numeric, higherIsBetter) — adds the
  qualitative tag ('median' for 50, 'worst N%' / 'best N%' at the
  tails) so labels read naturally regardless of which percentiles
  the API returns

Both the table renderer and the markdown renderer now iterate over
sortedPercentiles, so adding a new percentile key is zero-effort.

Verified against the live OpenRouter API for Gemini 2.5 Flash,
Qwen 3.6 Plus, Grok 4.1 Fast, and Claude Sonnet 4.5 — all currently
return the same {p50, p75, p90, p99} keys, but the parsing is now
future-proof.

Also fixed a header-box width bug: wide modality lists like Gemini's
'in: file/image/text/audio/video · out: text · tokenizer: Gemini'
were overflowing the right border because the box width was computed
from title/id only. The architecture line is now included in the
width calculation.


## [3.9.69] - 2026-04-10

### Changed

- Or_model_info table: row-per-percentile + fill in missing fields

Expanded the endpoint table so every metric is on its own row —
easier to read than the packed one-liner, and each value gets its
own independently-colored cell.

New rows:

- Endpoint name — the full backing id, often includes a versioned
  suffix like 'Nvidia | nvidia/nemotron-3-super-120b-a12b-20230311:free'
- Tag — shown when it differs from the provider name
- Status — 'operational' (code 0) or 'status code N' colored red
- Implicit caching — yes/no
- Image price, Request price, Discount — from the pricing object
  (previously only prompt/completion/cache-read were shown)
- Uptime (5m) — recent-window uptime, added alongside 30m and 1d

Restructured rows:

- Latency p50/p75/p90/p99 — now FOUR rows with clear labels
  ('Latency p50 (median)', 'Latency p99 (worst 1%)')
- Throughput p50/p75/p90/p99 — same treatment
  ('Throughput p50 (median)', 'Throughput p99 (best 1%)')

Each percentile row gets its own color classification, so the eye
can immediately spot the tail-latency red cells without scanning
a packed one-liner.

The ModelEndpoint interface grew to cover `tag`, `supports_implicit_caching`,
and `ModelEndpointPricing.discount`.


## [3.9.68] - 2026-04-10

### Changed

- Or_model_info: table formatter, CLI subcommand, shared module, legend

Three wins bundled into one change:

1. Factored the fetch and formatting logic out of index.ts into a new
   shared module src/or-model-info.ts with a clean interface:
     - fetchOpenRouterModelInfo(id, baseUrl, authToken) — returns
       a tagged union (ok|error)
     - formatModelInfoMarkdown(data, id) — plain markdown for
       programmatic consumers
     - formatModelInfoTable(data, id, colors) — Unicode-bordered
       ANSI-colored table for terminal display

2. New MCP tool 'or_model_info_table' — same input as or_model_info
   but returns the table form. Both tools now share the fetch code.
   Inline inline implementation in index.ts (>170 LOC) is gone.

3. New CLI subcommand 'llm-externalizer model-info <model-id>' —
   calls the shared module, defaults to the colored table format.
   Flags: --markdown (plain md output), --no-color (suppress ANSI,
   auto-detected when stdout is not a TTY or NO_COLOR is set).

   The CLI auth logic prefers the active profile when it's an
   openrouter-remote profile, falls back to $OPENROUTER_API_KEY so
   users can query OpenRouter metadata even from a local profile.

Table formatter highlights:

- Per-endpoint stacked tables with box-drawing characters
- Color-coded values by quality:
  - Uptime: ≥99% bright-green, ≥95% green, ≥90% yellow, <90% bright-red
  - Latency: <2s bright-green, <10s green, <30s yellow, ≥30s bright-red
  - Throughput: ≥50 tok/s bright-green, ≥20 green, ≥10 yellow, <10 red
  - Pricing: free = bright-green, paid = bright-yellow
- Supported parameters printed as a grid of ✓-marked entries
- Footer legend explaining percentiles (p50=median, p75/p90/p99=tail)
  and color key — so users don't need external knowledge

Latency and throughput values are now rounded to integers (were
rendering as '51161.00000000003ms' due to floating-point noise from
OpenRouter's response).

Skill now uses the CLI instead of the MCP tool — subagents can't
invoke MCP tools from plugins, so the CLI is the portable path.
The skill's examples show bash invocations, and the skill's
references/example-output.md gained a new 'Percentiles explained'
section with a concrete reading of Nemotron's p50/p75/p90/p99.


## [3.9.67] - 2026-04-10

### Changed

- Restructure or_model_info skill to satisfy CPV strict mode

CPV required:
- SKILL.md under 5000 chars (move detail to references/)
- ## Error Handling and ## Examples sections present
- Description under 250 chars with "Trigger with ..." phrase
- "Copy this checklist and track your progress" phrase
- Reference files with explicit Table of Contents
- Embedded TOC of each referenced file immediately after its link

New reference files under skills/llm-externalizer-or-model-info/references/:

- errors.md — full error table with 7 error codes and resolutions,
  plus debugging tips (partial-name workaround, :free vs paid id
  distinction, :thinking variants)
- example-output.md — complete sample response for
  nvidia/nemotron-3-super-120b-a12b:free with annotated explanation
  of how to read pricing, latency percentiles, throughput percentiles,
  and uptime
- use-cases.md — six primary scenarios: verify supported params,
  compare provider pricing, debug slow calls, check quantization,
  confirm context length, check reasoning support

SKILL.md now 4062 chars with embedded TOC summaries for each
referenced file so progressive discovery can find the sub-content.

CPV result: CRITICAL=0 MAJOR=0 MINOR=0.

- Add or_model_info tool + llm-externalizer-or-model-info skill

New MCP tool that queries OpenRouter's /v1/models/{exact_id}/endpoints
for any model and returns formatted metadata: architecture, per-endpoint
provider info, context length, pricing (per-M-tokens), supported
request-body parameters, quantization, uptime (30m / 1d), latency
percentiles, and throughput.

Required input: `model` — the EXACT OpenRouter model id, case-sensitive,
including vendor prefix and any :free / :thinking / :beta suffix. Only
works when the active profile is OpenRouter; returns a clear error
with a suggestion to switch profiles otherwise.

The tool is informational only, not an LLM call — not added to
LLM_TOOLS_SET, does not count toward session usage, no rate limiting.

New skill: skills/llm-externalizer-or-model-info/SKILL.md. Triggers on
phrases like "openrouter model info", "what params does X support",
"show pricing for model", "check model support", etc. Walks the caller
through parsing the exact model id (with fallback to asking for
clarification on partial names) and presents the markdown block.

Primary use cases:

- Verify supported_parameters before integrating a new model —
  Nemotron :free accepts `reasoning` + `temperature` + `top_p` but
  NOT `frequency_penalty` / `presence_penalty` / `top_k` / `min_p` /
  `stop`. The paid variant supports all of them. Important distinction.
- Compare pricing across multiple providers hosting the same model.
- Debug slow or failing calls by checking current uptime + latency.
- Look up quantization and max token limits for a specific endpoint.

The results are live — no caching on the MCP side. Every call hits
OpenRouter directly. Safe to call repeatedly.


## [3.9.66] - 2026-04-10

### Changed

- Dynamic per-model parameter filter from /v1/models/{id}/endpoints

OpenRouter exposes each model's accepted request-body fields via
/v1/models/{exact_id}/endpoints as `supported_parameters`. Query
this once per model, cache for 1 hour, and filter the outgoing
request body so unsupported fields are dropped before sending.

For nvidia/nemotron-3-super-120b-a12b:free the live API reports:
  reasoning, include_reasoning, temperature, max_tokens, seed,
  top_p, tools, tool_choice, structured_outputs, response_format

It does NOT accept: frequency_penalty, presence_penalty, top_k,
min_p, stop, repetition_penalty — sending any of these to the
free tier produces undefined behavior including the empty-response
problem we saw earlier.

New helpers:

- getModelSupportedParams(modelId) — queries the per-model endpoint
  with the EXACT model id, extracts the union of supported_parameters
  across all endpoints (providers) for the model, caches the Set.
  Returns null on failure so we proceed without filtering. Only
  active for OpenRouter backend.
- filterBodyForSupportedParams(body, supported) — drops keys in
  FILTERABLE_REQUEST_FIELDS that are not in the model's supported set.
  OpenRouter control fields (stream, plugins, messages, model,
  provider, metadata, debug, etc.) are NEVER filtered regardless.

Wired into both chatCompletionSimple and chatCompletionJSON just
after applyModelOverrides so it sees the final intended body.

Added docs/openrouter/get-models-api.md (671 lines) as the
authoritative reference for the /v1/models endpoint schema.

This is forward-compatible: any future model's parameter
restrictions are handled automatically without code changes.

- Add OpenRouter errors and debugging reference to docs/openrouter/

Saved from https://openrouter.ai/docs/api/reference/errors-and-debugging.md
for offline reference. Key sections:

- Error codes (400/401/402/403/408/429/502/503) — our classifyError
  logic is aligned with this list.
- 'When No Content is Generated' — documents that empty responses are
  expected during cold-start warm-up and provider scaling, and
  recommends a retry mechanism (which we already implement).
- Moderation error metadata shape — could be surfaced in report labels
  for finish_reason=content_filter cases.
- Debug option (debug.echo_upstream_body) — returns the exact request
  body OpenRouter forwards to the provider. Useful for verifying the
  reasoning.effort -> chat_template_kwargs.enable_thinking translation
  for Nemotron. Caveat: requires stream:true, which we removed, so it
  would need a temporary streaming branch to use for diagnosis.


## [3.9.65] - 2026-04-10

### Changed

- Align reasoning + model overrides with OpenRouter's real OpenAPI spec

Fetched the raw OpenAPI schemas for /chat/completions and /responses
and saved them to docs/openrouter/. Two prior releases were built on
an outdated best-practices doc page that advertised fields which do
not exist in the wire schema.

Corrections based on the saved specs:

- ChatRequestReasoning on /chat/completions has ONLY `effort` and
  `summary`. No `exclude`, `enabled`, or `max_tokens`. The earlier
  `exclude: true` field was silently dropped by OpenRouter. Removed
  from the ladder — the reasoning trace now comes back in
  message.reasoning / message.reasoning_details, which we already
  ignore in favour of message.content.

- Neither /chat/completions nor /responses has a generic vendor
  pass-through. `provider` has a fixed schema in both. Unknown
  top-level fields are not forwarded to the backend. Removed the
  v3.9.64 chat_template_kwargs extraBody for Nemotron — it was a
  no-op.

- For Nemotron, the ONLY supported path to enable thinking is
  `reasoning.effort`, which OpenRouter translates into the vLLM
  enable_thinking flag internally (the model metadata reports
  supports_reasoning=true, so the translation layer exists).

Kept:

- temperature: 1.0 and top_p: 0.95 overrides for Nemotron.
  These are standard schema fields and the primary root cause of
  the earlier empty-response failures — our default temperature=0.1
  was far below what Nemotron tolerates.

- The MODEL_REQUEST_OVERRIDES registry pattern. Trimmed to just
  temperature + top_p now that extraBody is gone.

Saved:

- docs/openrouter/chat-completions-api.md (81 KB raw OpenAPI)
- docs/openrouter/responses-api.md (129 KB raw OpenAPI)

These are the authoritative wire-format references for any future
changes to the request/response parsing code.


## [3.9.64] - 2026-04-10

### Changed

- Per-model request overrides: Nemotron needs temperature=1.0, top_p=0.95

Root cause of the empty-response failures on Nemotron 3 Super free:
our default temperature=0.1 is far below what the model tolerates.
NVIDIA's documented recommended settings are temperature=1.0,
top_p=0.95, and a vLLM chat_template_kwargs.enable_thinking flag.
The low sampling floor was collapsing the output distribution to
empty on large inputs.

New MODEL_REQUEST_OVERRIDES registry applies per-model sampling
params and vendor extraBody fields to the request body after the
reasoning ladder runs. For Nemotron free:

- temperature: 1.0 (override 0.1 default)
- top_p: 0.95 (we didn't send top_p at all before)
- extraBody.chat_template_kwargs.enable_thinking: true

OpenRouter wire format: the `provider` field has a fixed schema, so
extraBody is merged at the top level of the request body. OpenRouter
forwards known vendor params (safe_prompt for Mistral, raw_mode for
Hyperbolic, etc.) in this way. chat_template_kwargs may or may not
make it through — if it doesn't, OpenRouter's own
supports_reasoning=true metadata for this model implies internal
translation of our reasoning.effort field into enable_thinking, so
either path enables thinking.

reasoningLadderForModel no longer special-cases Nemotron — all
OpenRouter models go through the same xhigh -> high -> none ladder.
The new registry handles the sampling-param differences cleanly.

applyModelOverrides is wired into both chatCompletionSimple and
chatCompletionJSON after baseBody construction.


## [3.9.63] - 2026-04-10

### Changed

- Re-enable reasoning on structured-output calls

Previous release unnecessarily skipped reasoning entirely for
chatCompletionJSON when jsonSchema was requested. With `exclude: true`
on every reasoning config, the thinking trace never enters
`message.content`, so JSON.parse still sees pure output. The
`isReasoningRejectionError` ladder inside chatCompletionJSON already
handles providers that reject the reasoning + json_schema combination
— it downgrades xhigh -> high -> none automatically on 400 responses.

Keeps reasoning enforcement consistent across chat, code_task,
scan_folder, compare_files, check_against_specs, check_references,
check_imports AND the structured-output tools (fix_code, split_file,
extract_paths). Previously the last group quietly ran without
reasoning.


## [3.9.62] - 2026-04-10

### Changed

- Credit-aware free-mode fallback + reasoning/labeling polish

Reasoning:
- Nemotron free model capped at medium effort. xhigh/high empirically
  produced empty responses for large files, likely because OpenRouter
  does not plumb the reasoning field through to the NVIDIA endpoint for
  this free variant, or the free-tier budget cannot accommodate deep
  reasoning + output. Medium is the safe ceiling.
- Empty-response escalation: when chatCompletionWithRetry receives an
  empty response from an OpenRouter model, it now downgrades the
  MODEL_REASONING_CACHE entry (xhigh -> high -> none) for that model
  so the next retry attempt runs with less (or no) reasoning. Silent
  empty 200 responses are now handled in addition to explicit 400
  reasoning rejections.
- Structured-output path (chatCompletionJSON) skips reasoning entirely
  when jsonSchema is requested. Mixing json_schema with reasoning is
  untested across providers — some inline reasoning into the content
  field and break JSON.parse. Schema enforcement already delivers
  precise output, so this is a safe no-op.

Credit-aware fallback:
- New getOpenRouterBalance() helper queries /v1/key and /v1/credits,
  cached 60s. Returns Infinity for unlimited keys, NaN on failure.
- resolveModelOverride() replaces the old one-liner in the tool-handler
  switch. It forces FREE_MODEL_ID when: caller requested free=true, the
  session creditExhausted flag is set, or the pre-flight balance is
  below MIN_BALANCE_FOR_PAID_USD ($0.05).
- classifyError no longer aborts on 402. Sets creditExhausted instead
  and reports the error as recoverable. chatCompletionWithRetry catches
  402 mid-flight and immediately retries the failed call with the free
  model — no cooldown, no batch abort. The "never fail, switch to free"
  promise is now guaranteed for any in-flight request.

Labeling fix:
- formatFooter no longer emits the generic "partial result due to
  timeout" footer when the body already carries a specific label
  (TRUNCATED / EMPTY RESPONSE / BLOCKED / UPSTREAM ERROR / INCOMPLETE).
  The old footer was misleading for non-timeout failures. When no label
  is present (older paths or a real network timeout), the footer still
  appears but with neutral wording.


## [3.9.61] - 2026-04-10

### Changed

- Enable reasoning on OpenRouter and refactor publish flow

- Send `reasoning: { effort: "xhigh", exclude: true }` on all OpenRouter
  chat/completions calls. Fallback ladder: xhigh → high → none, cached
  per model so rejections are only probed once per session. The exclude
  flag keeps the reasoning chain out of the response body.
- Apply the ladder to both chatCompletionSimple and chatCompletionJSON,
  so regular tools and structured-output tools (fix_code, split_file,
  check_imports) both benefit.
- Fix truncation labeling: distinguish EMPTY RESPONSE (finish_reason="")
  from real TRUNCATED (length), BLOCKED (content_filter), UPSTREAM ERROR
  (error), and INCOMPLETE (unknown). content_filter no longer retries
  since the block is deterministic. `stop` with empty content now
  retries instead of being mistaken for success.
- Restructure publish.py so version bumping happens AFTER linting,
  typecheck, and CPV validation — a bad build no longer leaves a dirty
  working tree. Added pre-flight working-tree-clean check. Lint output
  redirects to reports_dev/publish/.


## [3.9.60] - 2026-04-10

### Changed

- Add linters to publish.py: eslint, ruff, shellcheck + output to reports_dev

- New ESLint flat config (mcp-server/eslint.config.mjs) for TypeScript
- Added lint/typecheck scripts to mcp-server/package.json
- Fixed 7 existing lint errors (dead code, unused imports, prefer-const)
- Updated ruff config: line-length 120, ignore E501
- publish.py run_checks() now runs: tsc, eslint, ruff, shellcheck
- All check output redirected to reports_dev/publish/<name>.log
- reports_dev/ added to .gitignore


## [3.9.59] - 2026-04-10

### Changed

- Add FILE_FORMAT_EXAMPLE to remaining system prompts

compare_files (pair mode), check_references (single-file), and
check_imports (both paths) were missing the format example.
Now ALL file-handling tools show the LLM the expected XML
wrapping format.


## [3.9.58] - 2026-04-10

### Changed

- Fix FILE_FORMAT_EXAMPLE: use {BRACES} for placeholders, not angle brackets


## [3.9.57] - 2026-04-10

### Changed

- Use <specs-filename>/<specs-file-content> for spec files

check_against_specs now wraps the specification file in distinct
XML tags to avoid confusion with source files. readFileAsCodeBlock
accepts a tagPrefix parameter (""|"specs-"). System prompt updated
to document the spec-specific format.


## [3.9.56] - 2026-04-10

### Changed

- Add FILE_FORMAT_EXAMPLE to system prompts

Shows LLMs the exact <filename>/<file-content> wrapping format
they'll receive, so they can parse multi-file batches reliably.
Injected before BREVITY_RULES in all file-handling tools.


## [3.9.55] - 2026-04-10

### Changed

- Use <filename>/<file-content> XML tags for file wrapping

Each file now wraps as:
  <filename>
  /path/to/file.ext
  </filename>
  <file-content>
  ```lang
  ...
  ```
  </file-content>

Cleaner separation of path and content, both unambiguously
delimited by XML tags. No escaping needed.


## [3.9.54] - 2026-04-10

### Changed

- Move file path before <file> tag, simplify wrapping

Format: "File: /path/to/file.ts\n<file>\n```lang\n...\n```\n</file>"
Path is visible and accessible without XML parsing. System prompts
updated to reference "line before each file tag".


## [3.9.53] - 2026-04-10

### Changed

- Simplify XML wrapping: use plain <file>...</file>, keep path in fence header


## [3.9.52] - 2026-04-10

### Changed

- Wrap file content in XML tags for clearer file delimitation

Each file is now wrapped: <file path="...">...code fence...</file>
Helps LLMs (especially weaker ones like Nemotron) parse multi-file
batches unambiguously. Quad backticks (min 4, auto-escalate) already
handle nested code fences safely. XML path attribute is escaped.
Updated all system prompts to reference the new delimiter.


## [3.9.51] - 2026-04-10

### Changed

- Fix last 2 stale references: reset 120s timeout, two models comments

- tool-reference.md: remove "up to 120s" from reset description
- config.ts: "two models" → "three models" in settings template comments
- Synced tool-reference.md across all 3 skill copies


## [3.9.50] - 2026-04-10

### Changed

- Add heartbeat to chatCompletionSimple for MCP keepalive

Sends progress notification every 30s while waiting for the
non-streaming HTTP response. Prevents MCP inactivity timeout
on long-running requests (reasoning models on large files).
Cleared in finally block — no timer leaks.


## [3.9.49] - 2026-04-10

### Changed

- Remove all streaming code — SSE, timedRead, reasoning detection

Deleted chatCompletionStreaming (~180 lines), timedRead helper,
READ_CHUNK_TIMEOUT_MS, reasoningDetected field. All LLM requests
now use chatCompletionSimple (stream: false, single JSON response).


## [3.9.48] - 2026-04-10

### Changed

- Switch ALL LLM requests to non-streaming (stream: false)

chatCompletionWithRetry now always uses chatCompletionSimple.
No SSE parsing, no progress tracking per-request, no reasoning
token detection. Batch-level heartbeat keeps MCP connection alive.
Removes reasoning timeout skip logic (dead code with non-streaming).
chatCompletionStreaming is now unused (kept for reference, will remove).


## [3.9.47] - 2026-04-10

### Changed

- Remove response_format: text — unsupported models would reject it


## [3.9.46] - 2026-04-10

### Changed

- Add non-streaming path for free model, no SSE parsing

New chatCompletionSimple: stream=false, response_format=text,
single JSON response. Used automatically when modelOverride is
set (free mode). No progress tracking, no SSE chunk parsing,
no reasoning token detection needed. Simpler and more reliable.


## [3.9.45] - 2026-04-09

### Changed

- Convert /free-scan command to llm-externalizer-free-scan skill

Skill triggers on "free scan", "scan for free", "cheap scan", etc.
Parses free-form prompt for path, extensions, exclude dirs, instructions.
Includes quality warning and reference files.
Removes the old command (superseded by skill).


## [3.9.44] - 2026-04-09

### Changed

- Improve /free-scan: accept free-form prompt with path, extensions, instructions

Parse prompt for folder path, file extensions, exclude dirs,
and LLM instructions. Examples:
  /free-scan find security issues
  /free-scan /path/to/src .ts .py find dead code
  /free-scan skip tests find TODO comments


## [3.9.43] - 2026-04-09

### Changed

- Add /free-scan command for zero-cost project scanning

Uses the free Nemotron 3 Super model (no ensemble, no cost).
Warns about lower quality and prompt logging.


## [3.9.42] - 2026-04-09

### Changed

- Document free mode as low quality in tool schema, README, rules

Free mode uses a significantly weaker model — more false positives,
missed bugs, shallow analysis. Updated tool description, README
comparison table, and rules file to set correct expectations.


## [3.9.41] - 2026-04-09

### Changed

- Fix all stale references found in audit

- 'two models' → 'three models' in 5 files (README, config skill, templates)
- qwen3.6-plus:free → qwen3.6-plus in config.ts template
- 120s timeout → 600s/removed in 4 skill files + index.ts reset desc
- Added third_model to ensemble profile template
- Synced tool-reference.md to scan skill copy


## [3.9.40] - 2026-04-09

### Changed

- Make OUTPUT_DIR a constant, thread outputDir through function chain

No global state mutation. OUTPUT_DIR is now const. Per-request
output_dir override is passed through ProcessOptions/RobustPerFileOpts
to saveResponse, same pattern as modelOverride. Each Claude Code
instance uses its own cwd for the default output path.


## [3.9.39] - 2026-04-09

### Changed

- Refactor free mode: pass modelOverride through chain, no global state

Replace save/restore currentBackend pattern with clean parameter
passing. modelOverride flows through:
  handler → processFileCheck/robustPerFileProcess → ensembleStreaming
ensembleStreaming checks modelOverride first, skips ensemble if set.
No global state mutation for free mode.


## [3.9.38] - 2026-04-09

### Changed

- Add free mode: nvidia/nemotron-3-super-120b-a12b:free

New 'free' parameter on all tools. When true:
- Uses NVIDIA Nemotron 3 Super (120B MoE, 12B active, 262K context)
- Skips ensemble (single model only)
- Zero cost on OpenRouter
- WARNING: prompts logged by provider (not for sensitive code)

Added to KNOWN_MODEL_LIMITS, tool schemas, README with comparison table.


## [3.9.37] - 2026-04-09

### Changed

- Add Output Modes section to README with comparison table

Explains modes 0/1/2 with pros, cons, response format examples,
and when to use each. Mode 0 (per-file) is the default.


## [3.9.36] - 2026-04-09

### Changed

- Fix README: add missing extensions/exclude_dirs params, remove stale temperature ref


## [3.9.35] - 2026-04-09

### Changed

- Fix stale references across all files after v3.9.34 changes

- Fix llm_externalizer_output → reports_dev/llm_externalizer in:
  server.json, bin/llm-ext, all skill reference files, examples
- Fix temperature references: remove 0.2/0.3, note fixed at 0.1
- Fix answer_mode defaults in CLI wrapper (0=default, not 2)
- Add output_dir to CLI wrapper tool catalog
- Resolve output_dir to absolute path in tool handler
- Sync scan skill reference copies from usage skill


## [3.9.34] - 2026-04-09

### Changed

- Per-file output mode, output_dir, fixed temperature, new defaults

- Default answer_mode changed to 0 (one report per file) for ALL tools
- Output directory: reports_dev/llm_externalizer/ (was llm_externalizer_output/)
- New output_dir parameter on all tools for custom output location
- Temperature fixed to 0.1 for all models (removed user parameter)
- Report filenames now include source filename for easy identification
- Updated README, rules, and scan skill docs


## [3.9.33] - 2026-04-08

### Changed

- Add 'Bug discovery statistics — coming soon' to cost chart


## [3.9.32] - 2026-04-08

### Changed

- Add percentage column to cost comparison chart

Shows savings vs Opus baseline: Sonnet 60%, Ensemble 8%.
Badges show -40% and -92% savings. Tightened subtitle to one line.


## [3.9.31] - 2026-04-08

### Changed

- Update cost chart with full 50-file project scan data

Previous chart only covered 8 .ts files. Now includes all 50 files
(.ts, .md, .py, .json, .yaml, .sh, .toml) — 729 KB, 20K lines.
Opus $4.26, Sonnet $2.56, Ensemble $0.35 (12x cheaper, actual
OpenRouter billing).


## [3.9.30] - 2026-04-08

### Changed

- Fix cost chart: correct OpenRouter prices, move to top of README

Opus is $5/$25 on OpenRouter (not $15/$75 Anthropic direct).
Chart now shows file count, total KB, and actual ensemble cost
from OpenRouter billing. Moved chart to top of README under description.


## [3.9.29] - 2026-04-08

### Changed

- Improve cost comparison chart: show project name, file stats, fix readability


## [3.9.28] - 2026-04-08

### Changed

- Fix scan skill: add required sections, self-contained references

Pass CPV validation: 0 MAJOR, 0 MINOR, 0 CRITICAL.


## [3.9.27] - 2026-04-08

### Changed

- Add cost comparison chart to README

Shows actual cost per project scan: Opus $2.53, Sonnet $0.51,
Ensemble $0.08 (32x cheaper). Based on real session data
scanning 8 TypeScript source files (88K input, 16K output tokens).


## [3.9.26] - 2026-04-08

### Changed

- Add project scan skill, update rules file

- New skill: llm-externalizer-scan — triggers on "scan project",
  "audit codebase", "full scan". Guides Claude through a full
  ensemble scan with proper parameters.
- Update ~/.claude/rules/use-llm-externalizer.md: fix stale values
  (115s→600s timeout, 2-model→3-model ensemble, add Qwen pricing,
  fix scan_folder defaults, add model fallback docs).


## [3.9.24] - 2026-04-08

### Changed

- Update README: 3-model ensemble with pricing, rate limiting, timeout fixes

- Document all 3 ensemble models (Gemini, Grok, Qwen) with pricing
- Add model fallback behavior (1-2 fail → partial results)
- Add rate limiting section (adaptive AIMD, auto-detected RPS)
- Fix timeout: 600s base, extended for reasoning models
- Remove stale 115s/120s references


## [3.9.23] - 2026-04-08

### Changed

- Remove deprecated qwen3.6-plus:free model variant

The free variant was deprecated by OpenRouter in April 2026.
Remove from KNOWN_MODEL_LIMITS. Paid qwen/qwen3.6-plus remains.


## [3.9.22] - 2026-04-07

### Changed

- Expand default directory exclusions in walkDir

Add .idea, .vscode, tmp, temp, .gradle, .cargo, vendor, out,
.output, bower_components, .pnpm-store, .eggs, .nx to
WALK_DEFAULT_EXCLUDE. These are non-project directories that
should never be scanned by default.


## [3.9.21] - 2026-04-07

### Changed

- Increase OpenRouter default timeout from 120s to 600s

Reasoning models (Qwen 3.6 Plus, etc.) need extended thinking time.
120s was too short — models would time out during the thinking phase.
600s base timeout + dynamic extension when reasoning tokens are flowing.


## [3.9.20] - 2026-04-07

### Changed

- Fix reasoning model timeout: detect thinking tokens, extend timeout dynamically

- Remove 115s hard cap (MCP_MAX_TIMEOUT_MS) — use profile timeout (300s default)
- Detect reasoning/thinking tokens in SSE stream (delta.reasoning, delta.reasoning_content)
- When reasoning tokens are actively flowing, suspend the soft timeout — model is working
- Don't retry when reasoning was detected but content is empty — retrying restarts thinking
- Progress notifications show "Reasoning… Xs (model is thinking)" during thinking phase
- Fixes Qwen 3.6 Plus truncation on large files (was timing out during thinking phase)


## [3.9.19] - 2026-04-07

### Changed

- Add BREVITY_RULES to all LLM system prompts

Instructs models to be succinct (bullets, no preamble, only
report findings, max 3 sentences per finding). Prevents
verbose output that wastes tokens and causes truncation on
weaker models like Qwen 3.6 Plus.


## [3.9.18] - 2026-04-07

### Changed

- Remove user-facing concurrency options, update docs

Rate limiting is now fully automatic — no max_concurrent,
max_in_flight, or max_rps profile fields needed.


## [3.9.16] - 2026-04-07

### Fixed

- Fix: llm-ext help — note absolute paths recommended, report save location


## [3.9.15] - 2026-04-07

### Fixed

- Fix: llm-ext event-driven handshake + line buffering + error handling

Rewrote MCP communication from hardcoded timeouts to event-driven:
- Wait for init response (id:0) before sending initialized + tool call
- Line-buffered JSON parsing handles partial chunks correctly
- Spawn error handler (node not found)
- Unexpected exit handler (server crash before response)
- Server path existence check with helpful error message
- Safe stdin writes (catch if already closed)
- Phase state machine: init → ready → waiting → done

Tested: --help, discover, chat (LLM round-trip), code_task (file analysis)


## [3.9.14] - 2026-04-07

### Fixed

- Fix: llm-ext MCP handshake — add initialized notification + stream parsing

Two bugs fixed:
1. Missing notifications/initialized after init response (required
   by MCP protocol before tool calls are accepted)
2. Server doesn't exit after responding — switched from on("close")
   to incremental stdout parsing that kills the child once the
   tool response (id:1) is received

Tested: discover (utility) and chat (LLM round-trip) both work.


## [3.9.13] - 2026-04-07

### Documentation

- Docs: add copy-paste snippet for enabling llm-ext in plugin agents


## [3.9.12] - 2026-04-07

### Added

- Feat: llm-ext CLI with built-in tool discovery via --help

Agents can self-discover available tools and parameters:
  llm-ext --help           → list all tools with descriptions
  llm-ext --help code_task → show parameters for a specific tool

Also: supports --key=value syntax, 10min timeout (not MCP-limited),
JSON array/object parsing for complex parameters.


## [3.9.11] - 2026-04-07

### Added

- Feat: add bin/llm-ext CLI wrapper for plugin agents

Plugin-shipped agents cannot use MCP tools directly (Claude Code
strips mcpServers from plugin agent frontmatter). bin/llm-ext lets
any agent call LLM Externalizer tools via Bash:

  node "${CLAUDE_PLUGIN_ROOT}/bin/llm-ext" code_task \
    --instructions "Find bugs" --input_files_paths /path/to/file.ts

Spawns the MCP server as a subprocess, sends one JSON-RPC tool call,
prints the result (file path), and exits. No config changes needed.


## [3.9.10] - 2026-04-07

### Added

- Feat: add bin/llm-externalizer standalone launcher

Ships a standalone launcher script at bin/llm-externalizer that
can be used to register the MCP server in .mcp.json or agent
frontmatter when the plugin's auto-started server is not available
(e.g., plugin-shipped agents that cannot use mcpServers frontmatter).

No npm publish needed — just point to the file via node.


## [3.9.9] - 2026-04-07

### Documentation

- Docs: add subagent access guide for plugin-shipped agents

Document the Claude Code security restriction: plugin-shipped agents
cannot use MCP servers (mcpServers frontmatter is stripped). Provide
3 workarounds: copy to user agents, direct node invocation from
plugin cache, or project .mcp.json registration.


## [3.9.8] - 2026-04-05

### Changed

- Revert: remove ensemble deadline — user will extend MCP timeout instead


## [3.9.7] - 2026-04-05

### Fixed

- Fix: 3-model ensemble deadline prevents MCP timeout on large files

When 3 models run in parallel on large files (91K+ prompt tokens),
the slowest model (often the free-tier Qwen) could exceed the 115s
MCP timeout, causing the caller to never receive the response even
though the server saved the report.

Now uses Promise.allSettled with a 100s deadline (15s margin). If
any model hasn't responded by the deadline, the result includes
the models that finished + a "(timed out)" note for the slow one.
The caller always gets a response within the MCP timeout.


## [3.9.6] - 2026-04-05

### Fixed

- Fix: add types:["node"] to tsconfig to resolve IDE false positives


## [3.9.5] - 2026-04-05

### Fixed

- Fix: publish.py cleanup + README steps updated

- Remove unused capture_output param from run() helper
- Fix comment numbering (step 8 → 9 for GitHub release)
- README: update publish steps to match new flow
  (bump first, then validate, CPV required)
- README: git-cliff now required, not optional
- README: add uvx to requirements for CPV validation


## [3.9.4] - 2026-04-05

### Added

- Feat: publish.py always bumps version first, then validates

New flow: bump → rebuild → validate (build+CPV) → badges →
changelog → commit → tag → push → release.

Version is always bumped (marketplace needs version change to
detect updates). Validation runs on the bumped code. If any
check fails, the uncommitted version bump is discarded.


## [3.9.3] - 2026-04-05

### Fixed

- Fix: simplify lock file protocol — existence = validation passed


## [3.9.2] - 2026-04-05

### Added

- Feat: pre-push hook skips when publish.py running, CPV now mandatory

- publish.py creates .publish.lock while running; pre-push hook
  checks for it and skips to avoid duplicate validation
- uvx/CPV validation is now REQUIRED (no skip if uvx missing)
- Push is always blocked unless all checks pass with 0 issues


## [3.9.1] - 2026-04-05

### Added

- Feat: unify pre-push hook with publish.py --check-only

publish.py gains --check-only flag that runs all validation
(build, manifest, CPV) without publishing. The pre-push hook
now delegates to publish.py --check-only instead of duplicating
checks. Single source of truth for all quality gates.


## [3.9.0] - 2026-04-05

### Added

- Feat: 3-model ensemble support (third_model)

Extend ensemble from 2 models to N models:
- Add third_model to Profile and ResolvedProfile interfaces
- Add validation: third_model only allowed in remote-ensemble mode
- getEnsembleModels() includes third model when configured
- ensembleStreaming() already handles N models via Promise.all
- Add ensembleModelLabel() helper (replaces 6 inline constructions)
- Add Qwen 3.6 Plus to KNOWN_MODEL_LIMITS (40K line input limit,
  conservative vs declared 1M to avoid accuracy degradation)
- Default ensemble profile includes qwen/qwen3.6-plus:free as third
- discover shows Third model when configured

All commands now produce 3-model reports in ensemble mode.


### Fixed

- Fix: cpv-remote-validate uses 'plugin' not 'cpv-validate'

- Fix: use cpv-remote-validate for isolated CPV execution


## [3.8.8] - 2026-04-02

### Fixed

- Fix: schema required arrays block folder_path-only calls

batch_check, check_references, check_imports all had
required: ["input_files_paths"] in their schemas, but handlers
support folder_path as alternative. MCP framework rejected calls
with only folder_path before the handler could process them.

Changed to required: [] with validation inside handlers.
Updated error messages to mention folder_path alternative.


## [3.8.7] - 2026-04-02

### Fixed

- Fix: resolve remaining deferred audit issues + dead code cleanup

Deferred fixes resolved:
- CC-P3-003: CLI cmdEdit no longer crashes on --timeout null/""
  (also fixed --context_window, --max_concurrent)
- CC-P3-006: publish.py porcelain filter uses column-based check
- CC-P3-008: config.ts getConfigDir follows symlinks via realpathSync
  before path boundary check (prevents symlink bypass)

Dead code removed (CC-P2-012/13/14/16):
- _INFERENCE_CONNECT_TIMEOUT_MS (unused constant)
- BATCHING_OUTPUT_ESTIMATE (unused constant)
- scoreModel + normalizeForMatch + ModelMatch + _findBestModels
  (entire unused fuzzy matching subsystem)
- _sessionSummary (unused function)

Other:
- LLM_TOOLS_SET moved to module level (was recreated per request)
- config.ts: settings.yaml gets chmod 0o600 + Windows path sep


## [3.8.6] - 2026-03-30

### Documentation

- Docs: comprehensive update for v3.8 features

- README: updated tools table, advanced parameters (folder_path,
  recursive, follow_symlinks, max_files, redact_regex, max_retries),
  compare_files 3 modes, plugin structure tree (no bash scripts)
- tool-reference: all new parameters, compare_files modes, folder_path
  on all tools, safety features with redact_regex
- usage-patterns: new examples for batch compare, git diff, folder_path,
  redact_regex; replaced batch_check with code_task answer_mode=0
- end-to-end-workflow: updated decision tree with all compare_files modes
- SKILL.md: updated examples and resource listing
- discover.md: references setup.py


### Fixed

- Fix: trim SKILL.md to <4000 chars, embed all 19 usage-patterns TOC headings


## [3.8.5] - 2026-03-30

### Fixed

- Fix: address 10 issues from full src audit (CC-P3-001 through CC-P3-012)

MUST-FIX:
- CC-P3-001: install_statusline.py — quote path for spaces in home dir
- CC-P3-002: publish.py — add cwd param to run(), remove os.chdir

SHOULD-FIX:
- CC-P3-003: cli.ts cmdEdit — defer to separate fix (numeric clearing)
- CC-P3-004: cli.ts parseFlags — support --key=value syntax
- CC-P3-005: statusline.py — Windows-portable strftime (%-X → %#X)
- CC-P3-006: publish.py — improved porcelain filter (deferred)
- CC-P3-007: config.ts — chmod 0o600 on settings.yaml after write
- CC-P3-008: config.ts — symlink guard (deferred, needs existsSync check)

NIT:
- CC-P3-011: statusline.py — move import re to top of file
- CC-P3-012: publish.py — use shlex.join for command logging
- Remove unused os import from publish.py


## [3.8.4] - 2026-03-30

### Miscellaneous

- Chore: remove old bash pre-push hook (replaced by .githooks/pre-push in Python)


## [3.8.3] - 2026-03-30

### Fixed

- Fix: address 11 issues from second audit (CC-P2-001 through CC-P2-011)

MUST-FIX:
- CC-P2-001: check_references — wire redact_regex to all readFileAsCodeBlock calls
- CC-P2-002: check_imports — wire redact_regex to all readFileAsCodeBlock calls
- CC-P2-003: chat mode-0 sequential — add regexRedact + maxBytes to processFileCheck
- CC-P2-004: code_task single-file — add regexRedact + maxBytes to processFileCheck
- CC-P2-005: code_task mode-0 sequential — add redact + regexRedact + maxBytes

SHOULD-FIX:
- CC-P2-007: comparePair — wrap ensembleStreaming in try/catch
- CC-P2-008: git ref injection — reject refs starting with '-'
- CC-P2-011: check_against_specs — allow combining folder_path + input_files_paths
  (use resolveFolderPath, merge results like other tools)

NIT:
- CC-P2-017: remove leftover output_dir from compare_files type assertion


## [3.8.2] - 2026-03-30

### Fixed

- Fix: address 10 issues from code correctness audit

MUST-FIX:
- CC-001: ReDoS — reject nested quantifier patterns (e.g. (a+)+)
  before compiling user-supplied regex
- CC-003: walkDir circular symlink — add regular directories to
  visitedPaths (not just symlink targets)
- CC-004: resolveFolderPath — add sanitizeInputPath for path
  traversal protection on folder_path

SHOULD-FIX:
- CC-007: compare_files required:[] — input_files_paths not required
  when using file_pairs or git_repo mode
- CC-008: batch_check — wire redact_regex through to processFileCheck
- CC-009: scan_folder — wire redact_regex through to processFileCheck
- CC-019: add check_against_specs to LLM_TOOLS tracking set so reset
  waits for in-flight spec checks to complete


## [3.8.1] - 2026-03-30

### Fixed

- Fix: ReDoS protection, git ls-files flag incompatibility, unused param

1. ReDoS: cap regex replacements at 100K to prevent catastrophic
   backtracking on pathological user-supplied patterns
2. git ls-files: split --recurse-submodules (tracked only) from
   --others (untracked) — these flags are incompatible in git
3. Remove unused output_dir parameter from compare_files schema
   (was declared but never wired to saveResponse)


## [3.8.0] - 2026-03-30

### Added

- Feat: compare_files batch mode + git diff mode + grouping

Three comparison modes:
1. PAIR MODE: input_files_paths with 2 files (backward compat)
2. BATCH MODE: file_pairs array of [fileA, fileB] pairs with
   ---GROUP:id--- markers for grouped reports
3. GIT DIFF MODE: git_repo + from_ref + to_ref — computes diffs
   via git between two commits/tags, supports grouping via
   file_pairs markers to organize changed files

All modes support per-group report saving. Git diff mode does
not use LLM — pure git diff with structured output.


## [3.7.2] - 2026-03-30

### Added

- Feat: respect gitignore across submodules and nested git repos

Replace single git ls-files call with gitLsFilesMultiRepo() that:
1. Runs git ls-files --recurse-submodules from the main repo
   (respects each submodule's own .gitignore)
2. Scans for independent nested git repos (separate .git dirs)
   and runs git ls-files in each one separately
3. Falls back to --cached --others --exclude-standard on older
   git that doesn't support --recurse-submodules
4. Deduplicates results across all repos
5. Falls back to manual walk if no git repos found at all


## [3.7.1] - 2026-03-30

### Added

- Feat: add folder_path support to batch_check (last tool missing it)


## [3.7.0] - 2026-03-30

### Added

- Feat: add folder_path to chat, code_task, check_references, check_imports

All content tools now accept folder_path as an alternative (or addition)
to input_files_paths. The folder is scanned with the same options as
scan_folder and check_against_specs: extensions, exclude_dirs,
use_gitignore (default: true), recursive (default: true),
follow_symlinks (default: true, with circular link detection),
max_files (default: 2500).

Also adds recursive and follow_symlinks options to walkDir and all
tools that use folder scanning. Symlink following uses realpath-based
cycle detection to prevent infinite loops.


## [3.6.4] - 2026-03-30

### Fixed

- Fix: scan_folder use_gitignore description said 'Default: false' but code defaults to true


## [3.6.3] - 2026-03-30

### Fixed

- Fix: raise max_files default from 1000 to 2500


## [3.6.2] - 2026-03-28

### Fixed

- Fix: explain WHY file grouping saves tokens in all tool descriptions


## [3.6.1] - 2026-03-28

### Fixed

- Fix: add FILE GROUPING section to all tool descriptions

The grouping feature (---GROUP:id--- markers) was not mentioned in
any tool description or input_files_paths parameter description.
Other Claude Code sessions could not discover the feature because
only answer_mode and max_retries were visible in the schema.

Added to all 6 supported tools:
- Tool description: FILE GROUPING section explaining the syntax
- chat's input_files_paths: full example of marker syntax


## [3.6.0] - 2026-03-28

### Added

- Feat: convert all bash scripts to Python for cross-platform support

- scripts/setup.sh → scripts/setup.py
- scripts/install-statusline.sh → scripts/install_statusline.py
- mcp-server/statusline.sh → mcp-server/statusline.py
- .githooks/pre-push converted to Python

All scripts use Python stdlib only (no external dependencies).
Works on macOS, Linux, and Windows without WSL/Cygwin.
Old .sh files kept for backward compatibility.


### Fixed

- Fix: update last setup.sh reference in README to setup.py


### Miscellaneous

- Chore: remove bash scripts replaced by Python equivalents


## [3.5.3] - 2026-03-28

### Fixed

- Fix: use numbered checklist, remove colon after 'Trigger with', comma-separated TOC

- Fix: resolve remaining CPV issues — numbered steps, TOC format, description format

- Fix: resolve all CPV validation issues (6 MINOR + 6 WARNING)

- Add pyproject.toml for Python plugin metadata
- Add .python-version (3.12)
- Add .githooks/pre-push quality gate
- Skills: add "Trigger with" to both descriptions (Nixtla strict mode)
- Skills: convert Instructions to checklist format ([ ] / [x])
- Skills: embed complete TOC from all referenced .md files in SKILL.md
- README: uppercase badge markers (<!--BADGES-START--> / <!--BADGES-END-->)
- README: document mcp-server/ directory purpose and Bash requirement
- publish.py: sync badge marker case with CPV expectations

- Fix: CPV must pass with 0 issues to allow publish


## [3.5.2] - 2026-03-28

### Added

- Feat: add CPV remote validation to publish pipeline

Step 1b runs CPV via uvx remote execution:
  uvx --from git+https://github.com/Emasoft/claude-plugins-validation cpv-validate

- Exit 0: pass (publish continues)
- Exit 2: minor issues (warn, publish continues)
- Exit 1: critical/major (publish blocked)
- uvx not found: skip with warning

No local CPV scripts needed — runs from GitHub repo directly.


### Fixed

- Fix: parse CPV output for severity instead of relying on exit codes


## [3.5.1] - 2026-03-28

### Documentation

- Docs: update README for v3.3–v3.5 features

- Add check_against_specs to tool table
- Mark batch_check as deprecated
- Add advanced parameters section (answer_mode, max_retries, redact_regex,
  scan_secrets, redact_secrets, max_payload_kb)
- Add file grouping section with syntax and output format
- Update feature list with grouping, redact_regex, robust batch
- Update skills description and plugin structure tree
- Fix tool count (12 → 13)


## [3.5.0] - 2026-03-28

### Added

- Feat: add redact_regex parameter to all content tools

User-defined regex pattern to redact matching strings from file content
before sending to LLM. Uses the same tested replacement format as
secret redaction: [REDACTED:USER_PATTERN] for alphanumeric matches,
zero-padded placeholders for numeric-only matches.

- Validates regex upfront with clear error messages on invalid patterns
- Applied after secret redaction (redact_secrets)
- Propagated through readFileAsCodeBlock, readAndGroupFiles,
  processFileCheck, and robustPerFileProcess
- Available on: chat, code_task, batch_check, scan_folder,
  compare_files, check_references, check_imports, check_against_specs


## [3.4.0] - 2026-03-28

### Added

- Feat: add max_retries parameter to all content tools, deprecate batch_check

Extract retry/circuit-breaker/parallel logic from batch_check into
shared robustPerFileProcess function. Add max_retries parameter to
chat, code_task, check_references, check_imports, check_against_specs.

When answer_mode=0 and max_retries > 1:
- Parallel execution via parallelLimit
- Per-file retry with exponential backoff
- Circuit breaker (abort after 3 consecutive failures)
- Global retry budget (2x file count)

batch_check is now deprecated — use any tool with
answer_mode=0, max_retries=3 for equivalent behavior.

Also fixes: filter group markers from secret scans in chat,
code_task, and check_against_specs handlers.


### Documentation

- Docs: add max_retries to tool reference, mark batch_check as deprecated


## [3.3.1] - 2026-03-28

### Fixed

- Fix: filter group markers from secret scans and single-file checks

- chat, code_task: filter ---GROUP:*--- markers before passing to
  scanFilesForSecrets (would try to read markers as file paths)
- check_against_specs: same marker filtering for secret scan
- code_task: single-file optimization also checks GROUP_FOOTER_RE
  (previously only checked GROUP_HEADER_RE, so a lone footer marker
  could pass through to processFileCheck)
- batch_check, check_references, check_imports already had this
  filtering from the initial implementation


## [3.3.0] - 2026-03-28

### Added

- Feat: add file grouping support for isolated batch processing

Files in input_files_paths can be organized into named groups using
delimiter markers: ---GROUP:id--- and ---/GROUP:id---. Each group is
processed in complete isolation (no cross-group LLM calls) and produces
its own report file with the group ID in the filename.

Supported tools: chat, code_task, batch_check, check_references,
check_imports, check_against_specs.

Output format: [group:id] /path/to/report.md (one line per group)

Backward compatible: flat file lists without markers work unchanged.
Groups apply only to input_files_paths, not instructions or spec files.


### Documentation

- Docs: add file grouping documentation to skill references

- tool-reference: new File Grouping section with syntax, output format,
  and supported tools list
- usage-patterns: grouped file processing example with expected output
- SKILL.md: updated resource listing


## [3.2.9] - 2026-03-28

### Changed

- Update plugin for Claude Code v2.1.80–v2.1.86 compatibility

- statusline: use rate_limits from input JSON (v2.1.80+) instead of
  OAuth token lookup + API call; falls back to API for older versions
- commands: add effort frontmatter (v2.1.76) — discover:low, configure:medium
- docs: add check_against_specs to tool reference, usage patterns,
  decision tree, and skill trigger list (was added in v3.2.8 but
  undocumented in skill files)


### Fixed

- Fix: statusline mkdir race + docs inconsistencies

- Move mkdir /tmp/claude before OpenRouter cache write (was inside
  fallback-only branch, but OpenRouter write runs unconditionally)
- tool-reference: exclude_dirs and use_gitignore apply to both
  scan_folder and check_against_specs, not scan_folder only
- tool-reference: note check_against_specs uses spec_file_path
  instead of standard 4-field input pattern


## [3.2.8] - 2026-03-26

### Added

- Feat: add check_spec tool — compare source files against a specification

New tool that accepts a spec file (requirements, rules, API contracts,
restrictions, forbidden patterns) and one or more source files. Each
source file is strictly examined for spec violations.

Key design decisions:
- Reports ONLY VIOLATIONS (things done wrong), not MISSING features
  (some requirements may be implemented in other files not included)
- Everything implemented must follow the spec exactly
- Per-violation reporting: file, location (function name), spec rule
  quoted, actual behavior, severity (CRITICAL/HIGH/MEDIUM/LOW)
- Files with no violations explicitly marked "CLEAN"
- Supports FFD bin packing for multi-file batches
- Spec file included as "source of truth" in every batch
- Ensemble mode for dual-model analysis
- Summary with total violation counts by severity


### Fixed

- Fix: max_files default 1000, useGitignore default true

- max_files: 500 → 1000 for both scan_folder and check_against_specs
- useGitignore: false → true (respects .gitignore by default)
- .git, .venv already in WALK_DEFAULT_EXCLUDE (confirmed)

- Fix: apply rechecker fixes [rechecker: skip]

Auto-reviewed and fixed by rechecker plugin.

Pass 3 (adversarial) — 2 medium:
- check_against_specs: added isDirectory() check on folder_path
- check_against_specs: reject when both folder_path and input_files_paths provided

Pass 4 (security) — 2 (1 medium, 1 low):
- check_against_specs: added maxFiles:500 safety limit on walkDir
- check_against_specs: exposed max_files parameter in tool schema

- Fix: remove stale max_tokens references from tool descriptions

limitsBlock() and discover tool still mentioned max_tokens as
user-configurable. Updated to reflect that output tokens are
auto-managed (model maximum) and truncation is auto-retried.


### Refactored

- Refactor: rename check_spec → check_against_specs + folder scanning

Renamed tool and added folder_path support for recursive scanning.
Spec file is included in EVERY batch — when files are split across
multiple requests via FFD bin packing, each batch gets the full spec
so every source file is always checked against the complete spec.

New parameters:
- folder_path: scan a directory recursively instead of listing files
- extensions: filter by file extension (e.g., [".ts", ".py"])
- exclude_dirs: additional directories to skip
- use_gitignore: respect .gitignore rules via git ls-files

Either input_files_paths OR folder_path is required (not both).
No limit on number of files — the packing algorithm handles it.


## [3.2.7] - 2026-03-26

### Added

- Feat: global service health tracker + truncation in output reports

Added SERVICE_HEALTH global tracker that detects systemic server issues:
- Tracks consecutive failures across ALL requests (not just per-batch)
- Threshold: 5 consecutive failures triggers backoff mode
- Exponential backoff: waits 60s, 120s, 350s between retry attempts
- After all backoff attempts fail, returns clear server-side error:
  "The issue appears to be server-side... please retry later"

Truncation now appears in output reports (not just stderr):
- finishReason=length: appends "TRUNCATED: output token limit hit"
- Timeout after 3 retries: appends "TRUNCATED: still incomplete after 3 retries"
- Server abort: returns the full SERVICE_HEALTH diagnostic message

This prevents wasting thousands of tokens on batch operations when the
server is down — the system detects the pattern early and stops.

- Feat: auto-retry on truncated LLM responses (up to 3 retries)

Added chatCompletionWithRetry wrapper that checks finishReason from
the OpenRouter API after each streaming call:

- finishReason="stop" + !truncated → normal completion, return immediately
- finishReason="length" → output hit max_tokens limit, return with
  truncated=true warning (retrying won't help — same limit)
- truncated=true (timeout/connection drop) → retry up to 3 times

Each ensemble model retries independently — if Grok times out but
Gemini succeeds, only Grok retries. The combined result reflects
whether any model was still truncated after all retries.

This ensures the output is never silently truncated. The retry logic
is transparent: each retry is logged to stderr with attempt count.


### Miscellaneous

- Chore: gitignore tldr session artifacts

- Chore: add Serena project config, remove stale worktrees


### Refactored

- Refactor: remove ensemble and max_tokens from tool parameters

Ensemble is now always ON for remote backends (OpenRouter) and OFF
for local backends — not user-configurable. This ensures every file
is analyzed by both models when using the remote ensemble profile.

max_tokens is now always set to the model's maximum output capacity
via resolveDefaultMaxTokens(). The ensemble dispatch already caps
each model at its KNOWN_MODEL_LIMITS.maxOutput (Grok: 30K, Gemini: 65K).

Removed:
- ensembleSchema constant
- ensemble parameter from all 11 tool schemas
- max_tokens parameter from all 11 tool schemas
- All dead variable extractions from handler destructuring blocks

The only user-configurable size parameter is max_payload_kb (default 400),
which controls how files are packed into batches via FFD bin packing.


## [3.2.6] - 2026-03-23

### Added

- Feat: configurable max_payload_kb on all tools + FFD bin packing

Ensemble requires both models to process every batch, so the payload
budget must fit within the WEAKER model's context (Grok 4.1 Fast:
~131K tokens ≈ 400 KB after output/prompt overhead).

Changes:
- DEFAULT_MAX_PAYLOAD_BYTES: 800 KB → 400 KB (conservative for Grok)
- readFileAsCodeBlock: accepts optional maxBytes parameter
- readAndGroupFiles: FFD (First-Fit Decreasing) bin packing for
  optimal batch composition, configurable budgetBytes parameter
- max_payload_kb parameter added to ALL 7 content tools:
  chat, code_task, batch_check, scan_folder, compare_files,
  check_references, check_imports
- Budget threaded through to every readFileAsCodeBlock call site
  via ProcessOptions.maxBytes and direct parameter passing
- Token estimation: 1 token ≈ 4 bytes (prompt bytes subtracted
  from budget before grouping files)


### Fixed

- Fix: comprehensive adversarial audit — 32 findings across all severity levels

CRITICAL fixes:
- C1: Path traversal protection — sanitizeInputPath() rejects paths outside
  cwd/home/tmp and blocks symlinks on all input file reads
- C2: Redaction ID race — replaced sequential nextRedactionId++ with
  randomUUID() (thread-safe, unpredictable placeholders)
- C3: File lock race — documented Map-based lock with resolve() normalization

HIGH fixes:
- H1: Prompt bytes now computed via Buffer.byteLength (not token*4 estimate),
  accurate for CJK/emoji/non-ASCII content
- H2: Symlink rejection via lstatSync check in sanitizeInputPath
- H3: Global retry cap (2× file count) in batch_check prevents quota exhaustion
- H4: Malformed SSE chunks counted and warned (not silently dropped)
- H5: maxBytes validated — Infinity/0/negative fall back to default
- H6: walkDir skips symlinks explicitly (prevents infinite recursion)
- H7: PEM private key blocks added to SECRET_PATTERNS
- H8: publish.py rollback on push failure (reset + tag delete)
- H9: publish.py validates regex match + greps dist for version
- H10: config.ts YAML parse sanitized via JSON roundtrip (anti-prototype-pollution)

MEDIUM fixes:
- M1: readAndGroupFiles enforces 10 KB minimum budget
- M2: System message bytes included in budget calculation
- M3: TOCTOU mitigated — re-check buffer size after readFileSync
- M4: Truncation detection lowered from >50 to >10 lines
- M5: SOFT_TIMEOUT_MS capped at 115s (MCP spec limit)
- M6: (ensemble line filter — secondary to byte budget)
- M7: config.ts atomic settings write via temp+rename
- M8: config.ts path traversal protection on LLM_EXT_CONFIG_DIR
- M9: config.ts env var name trimming
- M10: config.ts numeric caps (timeout ≤3600, concurrent ≤32, context ≤10M)
- M11: publish.py remote tag collision check via git ls-remote

LOW fixes:
- L1: Binary detection scan extended from 8KB to 64KB
- L4: Connection drop mid-stream now sets truncated=true
- L5: Progress interval dynamic (min 10s, timeout/3)
- L6: detectLang fallback to shebang for extensionless files
- L7: walkDir symlink skip explicit (was implicit)
- L8: Redaction IDs now random UUIDs (unpredictable)

Additional publish.py hardening:
- git-cliff required (not optional skip)
- gh CLI pre-check at start
- npm ci instead of npm install
- try/finally on os.chdir for safety
- Post-stage unstaged file detection

- Fix: 800 KB payload budget for batching — guarantees full ensemble

The entire LLM payload (prompt + instructions + instruction files +
code files + inline content) is now capped at 800 KB per batch.

This ensures both ensemble models (Grok ≤20K lines ≈ 800 KB,
Gemini ≤50K lines ≈ 2 MB) always process every batch — no more
silent model skipping when batches exceed line limits.

Changes:
- MAX_FILE_SIZE_BYTES: 2 MB → 800 KB (per-file hard limit)
- readAndGroupFiles: byte-based batching (800 KB - prompt overhead)
  instead of token-based context window math
- Files exceeding 800 KB are skipped and reported (not crashed)
- Token estimation: 1 token ≈ 4 bytes (so 800 KB ≈ 200K tokens)
- chat + code_task callers report skipped files in output


## [3.2.5] - 2026-03-15

### Fixed

- Fix: rebuild dist after version sync in publish.py

The publish script synced the version to src/index.ts but didn't
rebuild dist/ before committing. This caused dist/index.js to report
the old version (3.2.2) to MCP clients while all other files said 3.2.4.

Now publish.py rebuilds dist as step 2b (after version sync, before
commit) and stages the rebuilt dist files.


## [3.2.3] - 2026-03-15

### Added

- Feat: bundle all dependencies with esbuild for standalone dist/

Claude Code plugins pull source from GitHub where node_modules is
gitignored. The previous tsc-only build produced dist/ files that
import external packages (yaml, @modelcontextprotocol/sdk) which
fail at runtime with "Cannot find package" errors.

Now using esbuild to bundle all npm dependencies into self-contained
dist/index.js and dist/cli.js. Node.js builtins are externalized.
A createRequire banner is injected so bundled CJS deps (like yaml)
can resolve require("process") in the ESM output.

Build pipeline: tsc --noEmit (type-check) → esbuild (bundle)


## [3.2.2] - 2026-03-15

### Documentation

- Docs: update install instructions with marketplace update step

Add `claude plugin marketplace update` command to installation guide.
Include note about refreshing local cache if plugin is not found.


### Fixed

- Fix: remove env block from .mcp.json to fix missing env var error

Claude Code treats all ${VAR} references in .mcp.json env block as
required, causing "Missing environment variables: VLLM_API_KEY" error
when users don't have all backend-specific vars set.

The MCP server process inherits the parent's environment automatically,
so OPENROUTER_API_KEY, LM_API_TOKEN, and VLLM_API_KEY are already
available via process.env when set in the user's shell. The env block
was unnecessary and counterproductive.

- Fix: comprehensive audit — security hardening, version sync, skill structure, CI

Security fixes:
- /tmp/claude/ directory created with mode 0700 (was world-readable)
- diff args use -- to prevent flag injection
- jq check + safe --arg interpolation in install-statusline.sh
- Dynamic User-Agent in statusline.sh (was hardcoded 2.1.34)
- Explicit UTF-8 encoding in pre-push hook

Version sync:
- Fix hardcoded version 3.1.0 in index.ts Server constructor → 3.2.1
- publish.py now auto-syncs version to index.ts on release
- index.ts staged for commit in publish pipeline

Plugin structure:
- Add VLLM_API_KEY to server.json environmentVariables
- Remove non-existent README.md from package.json files array
- Fix .mcp.json path syntax: $CLAUDE_PLUGIN_ROOT → ${CLAUDE_PLUGIN_ROOT}
- Fix dead URL in README (removed link to non-existent upstream repo)
- SHA-pin actions/checkout in notify-marketplace workflow
- Add CI workflow (build check + manifest + version consistency)

Skill improvements (Nixtla compliance):
- Lowercase skill names matching directory names
- Add required sections: Overview, Prerequisites, Instructions, Context,
  Output, Error Handling, Examples, Resources
- Progressive disclosure: move detailed content to reference files
- Both SKILL.md files under 5000 char limit
- TOC added to all reference files
- Embedded TOC headings in Resources section links
- Fix misleading description (config skill manages profiles, not backends)

CPV validation: 2 CRITICAL + 19 MAJOR → 0 CRITICAL + 0 MAJOR + 4 MINOR

- Fix: commit dist/, sync versions, harden publish pipeline

Critical fixes found during audit:

1. CRITICAL: mcp-server/dist/ was gitignored — MCP server would fail
   to start after install from GitHub because dist/index.js didn't
   exist. Removed dist/ from .gitignore with negation pattern, committed
   all 9 built files (548K).

2. Version mismatch: server.json and package.json were still at 3.2.0
   while plugin.json was at 3.2.1. Fixed both to 3.2.1.

3. publish.py now auto-syncs version to mcp-server/package.json and
   mcp-server/server.json (including nested packages[].version) and
   stages both files in the release commit.

4. tsconfig.json: excluded test-helpers.ts from build output to keep
   dist/ clean (only ships index.js, config.js, cli.js + declarations).

5. README badge version updated from 3.2.0 to 3.2.1.

- Fix: add cliff.toml and harden publish.py changelog generation

- Add cliff.toml with filter_unconventional=false and catch-all parser
  so no commits are ever skipped by git-cliff
- publish.py: add step 3 to update README.md badges (version, build)
- publish.py: capture git-cliff stderr and abort if commits are skipped
- publish.py: abort on git-cliff non-zero exit
- publish.py: stage README.md in commit alongside plugin.json + CHANGELOG
- Regenerate CHANGELOG.md with all 6 prior commits included


## [3.2.1] - 2026-03-15

### Changed

- Fix moderate vulnerability: update hono 4.12.5 -> 4.12.8

Resolves GHSA prototype pollution in hono's parseBody({ dot: true }).
Transitive dependency via @modelcontextprotocol/sdk. Patched in 4.12.7,
updated to 4.12.8. npm audit now shows 0 vulnerabilities.

- Improve README with badges, detailed tool docs, and publishing guide

Add shields.io badges (version, build, typescript, node, license,
marketplace) with badges-start/end markers. Expand MCP tools section
with input fields, ensemble parameters, and constraints. Add profile
modes table, environment variables reference, quick start configs for
both OpenRouter and LM Studio. Document publish.py steps and pre-push
hook checks. Add requirements table and full directory tree.

- Update .gitignore to match marketplace plugin conventions

Add patterns for: .claude/, CLAUDE.md, .tldr/, *_dev/ (generic), IDE
files (.idea/, .vscode/), Python caches (.ruff_cache/, .mypy_cache/,
.pytest_cache/), build artifacts, security output, and editor swap files.
Matches Emasoft/claude-plugins-management .gitignore pattern.

- Add CI/CD scripts and fix plugin naming convention

- Rename plugin from 'llm-externalizer-plugin' to 'llm-externalizer'
  (repo name stays llm-externalizer-plugin, matching token-reporter pattern)
- Add homepage field to plugin.json
- Add notify-marketplace.yml GitHub Action (triggers emasoft-plugins update)
- Add publish.py release pipeline (bump, changelog, tag, push, gh release)
- Add bump_version.py for semver bumps in plugin.json
- Add pre-push git hook (TypeScript build check + manifest validation)
- Rewrite README with comprehensive installation instructions, naming
  section, directory structure, and publishing guide
- Update .gitignore to include dev folders

- Apply validation fixes from plugin-validator and skill-reviewers

Fixes:
- server.json: version 3.1.0 -> 3.2.0, settings.yml -> settings.yaml
- Both SKILL.md descriptions: rewritten to third-person trigger phrases
- Config SKILL.md: added troubleshooting table, CLI commands section,
  fixed agent-directed phrasing in auth resolution section
- Usage SKILL.md: added instructions_files_paths guidance, enhanced
  output location constraint, added examples/ pointer
- New: examples/end-to-end-workflow.md with complete tool selection,
  invocation, output reading, and decision tree

- Initial plugin structure for llm-externalizer-plugin

Claude Code plugin packaging of the LLM Externalizer MCP server.

Components:
- .claude-plugin/plugin.json: Plugin manifest (v3.2.0)
- .mcp.json: MCP server config using $CLAUDE_PLUGIN_ROOT
- mcp-server/: Bundled MCP server source (copied from llm_externalizer)
- skills/llm-externalizer-usage/: Tool selection, patterns, constraints
- skills/llm-externalizer-config/: Profile management, settings, ensemble
- commands/discover.md: Health check command
- commands/configure.md: Profile management command
- scripts/setup.sh: Build script (npm install + tsc)
- scripts/install-statusline.sh: Optional statusline integration



