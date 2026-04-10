# Changelog

All notable changes to this project will be documented in this file.
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

- Llm-ext help — note absolute paths recommended, report save location

## [3.9.15] - 2026-04-07

### Fixed

- Llm-ext event-driven handshake + line buffering + error handling

## [3.9.14] - 2026-04-07

### Fixed

- Llm-ext MCP handshake — add initialized notification + stream parsing

## [3.9.13] - 2026-04-07

### Documentation

- Add copy-paste snippet for enabling llm-ext in plugin agents

## [3.9.12] - 2026-04-07

### Added

- Llm-ext CLI with built-in tool discovery via --help

## [3.9.11] - 2026-04-07

### Added

- Add bin/llm-ext CLI wrapper for plugin agents

## [3.9.10] - 2026-04-07

### Added

- Add bin/llm-externalizer standalone launcher

## [3.9.9] - 2026-04-07

### Documentation

- Add subagent access guide for plugin-shipped agents

## [3.9.8] - 2026-04-05

### Changed

- Remove ensemble deadline — user will extend MCP timeout instead

## [3.9.7] - 2026-04-05

### Fixed

- 3-model ensemble deadline prevents MCP timeout on large files

## [3.9.6] - 2026-04-05

### Fixed

- Add types:["node"] to tsconfig to resolve IDE false positives

## [3.9.5] - 2026-04-05

### Fixed

- Publish.py cleanup + README steps updated

## [3.9.4] - 2026-04-05

### Added

- Publish.py always bumps version first, then validates

## [3.9.3] - 2026-04-05

### Fixed

- Simplify lock file protocol — existence = validation passed

## [3.9.2] - 2026-04-05

### Added

- Pre-push hook skips when publish.py running, CPV now mandatory

## [3.9.1] - 2026-04-05

### Added

- Unify pre-push hook with publish.py --check-only

## [3.9.0] - 2026-04-05

### Added

- 3-model ensemble support (third_model)

### Fixed

- Cpv-remote-validate uses 'plugin' not 'cpv-validate'
- Use cpv-remote-validate for isolated CPV execution

## [3.8.8] - 2026-04-02

### Fixed

- Schema required arrays block folder_path-only calls

## [3.8.7] - 2026-04-02

### Fixed

- Resolve remaining deferred audit issues + dead code cleanup

## [3.8.6] - 2026-03-30

### Documentation

- Comprehensive update for v3.8 features

### Fixed

- Trim SKILL.md to <4000 chars, embed all 19 usage-patterns TOC headings

## [3.8.5] - 2026-03-30

### Fixed

- Address 10 issues from full src audit (CC-P3-001 through CC-P3-012)

## [3.8.4] - 2026-03-30

### Miscellaneous

- Remove old bash pre-push hook (replaced by .githooks/pre-push in Python)

## [3.8.3] - 2026-03-30

### Fixed

- Address 11 issues from second audit (CC-P2-001 through CC-P2-011)

## [3.8.2] - 2026-03-30

### Fixed

- Address 10 issues from code correctness audit

## [3.8.1] - 2026-03-30

### Fixed

- ReDoS protection, git ls-files flag incompatibility, unused param

## [3.8.0] - 2026-03-30

### Added

- Compare_files batch mode + git diff mode + grouping

## [3.7.2] - 2026-03-30

### Added

- Respect gitignore across submodules and nested git repos

## [3.7.1] - 2026-03-30

### Added

- Add folder_path support to batch_check (last tool missing it)

## [3.7.0] - 2026-03-30

### Added

- Add folder_path to chat, code_task, check_references, check_imports

## [3.6.4] - 2026-03-30

### Fixed

- Scan_folder use_gitignore description said 'Default: false' but code defaults to true

## [3.6.3] - 2026-03-30

### Fixed

- Raise max_files default from 1000 to 2500

## [3.6.2] - 2026-03-28

### Fixed

- Explain WHY file grouping saves tokens in all tool descriptions

## [3.6.1] - 2026-03-28

### Fixed

- Add FILE GROUPING section to all tool descriptions

## [3.6.0] - 2026-03-28

### Added

- Convert all bash scripts to Python for cross-platform support

### Fixed

- Update last setup.sh reference in README to setup.py

### Miscellaneous

- Remove bash scripts replaced by Python equivalents

## [3.5.3] - 2026-03-28

### Fixed

- Use numbered checklist, remove colon after 'Trigger with', comma-separated TOC
- Resolve remaining CPV issues — numbered steps, TOC format, description format
- Resolve all CPV validation issues (6 MINOR + 6 WARNING)
- CPV must pass with 0 issues to allow publish

## [3.5.2] - 2026-03-28

### Added

- Add CPV remote validation to publish pipeline

### Fixed

- Parse CPV output for severity instead of relying on exit codes

## [3.5.1] - 2026-03-28

### Documentation

- Update README for v3.3–v3.5 features

## [3.5.0] - 2026-03-28

### Added

- Add redact_regex parameter to all content tools

## [3.4.0] - 2026-03-28

### Added

- Add max_retries parameter to all content tools, deprecate batch_check

### Documentation

- Add max_retries to tool reference, mark batch_check as deprecated

## [3.3.1] - 2026-03-28

### Fixed

- Filter group markers from secret scans and single-file checks

## [3.3.0] - 2026-03-28

### Added

- Add file grouping support for isolated batch processing

### Documentation

- Add file grouping documentation to skill references

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

- Statusline mkdir race + docs inconsistencies

## [3.2.8] - 2026-03-26

### Added

- Add check_spec tool — compare source files against a specification

### Fixed

- Max_files default 1000, useGitignore default true
- Apply rechecker fixes [rechecker: skip]
- Remove stale max_tokens references from tool descriptions

### Refactored

- Rename check_spec → check_against_specs + folder scanning

## [3.2.7] - 2026-03-26

### Added

- Global service health tracker + truncation in output reports
- Auto-retry on truncated LLM responses (up to 3 retries)

### Miscellaneous

- Gitignore tldr session artifacts
- Add Serena project config, remove stale worktrees

### Refactored

- Remove ensemble and max_tokens from tool parameters

## [3.2.6] - 2026-03-23

### Added

- Configurable max_payload_kb on all tools + FFD bin packing

### Fixed

- Comprehensive adversarial audit — 32 findings across all severity levels
- 800 KB payload budget for batching — guarantees full ensemble

## [3.2.5] - 2026-03-15

### Fixed

- Rebuild dist after version sync in publish.py

## [3.2.3] - 2026-03-15

### Added

- Bundle all dependencies with esbuild for standalone dist/

## [3.2.2] - 2026-03-15

### Documentation

- Update install instructions with marketplace update step

### Fixed

- Remove env block from .mcp.json to fix missing env var error
- Comprehensive audit — security hardening, version sync, skill structure, CI
- Commit dist/, sync versions, harden publish pipeline
- Add cliff.toml and harden publish.py changelog generation

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


