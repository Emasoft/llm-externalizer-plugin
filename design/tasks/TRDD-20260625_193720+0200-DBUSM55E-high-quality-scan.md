---
trdd-id: DBUSM55E
title: high_quality_scan + high_quality_scan_and_fix — single good model, configurable, Opus verify-fix
column: dev
created: 2026-06-25T19:37:20+0200
updated: 2026-06-25T21:13:26+0200
current-owner: claude-llm-externalizer
assignee: claude-llm-externalizer
priority: 2
severity: MEDIUM
effort: L
labels: [scan, config, mcp-tool, cli, slash-command, openrouter]
task-type: feature
parent-trdd: null
npt: []
eht: []
blocked-by: []
relevant-rules: []
release-via: publish
delivery: direct-push
target-branch: main
test-requirements: [unit, typecheck, lint]
audit-requirements: []
review-requirements: [human-review]
runtime-targets: [macos, linux]
impacts: [config-schema, public-api]
attempts: 0
test-failures: 0
last-test-result: not-run
implementation-commits: []
external-refs: []
---

# high_quality_scan + high_quality_scan_and_fix

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-06-25

**Goal (user's verbatim intent):** add a new scan mode `llm-externalizer-high-quality-scan`
and `llm-externalizer-high-quality-scan-and-fix`, as MCP tool + CLI + slash command. Uses
ONE good remote model (NOT the 3-model ensemble). Supports all the same output-mode
customizations. The fix variant uses **Opus** to **verify then fix** the reported issues in
the same turn. The high-quality model is configurable in the YAML, default **GLM 5.2**
(`z-ai/glm-5.2`) at **max reasoning effort** (→ OpenRouter `xhigh`), **cache enabled**,
**FP8-or-higher quantization**, preferred provider **GMICloud** (`gmicloud/fp8`).

**Current state (2026-06-25):** Phases 1-3 DONE + committed, all green.
- P1 config (7c8ec92): `HighQualityModel`/`ResolvedHighQualityModel` types + `resolveHighQualityModel`;
  per-profile `high_quality_model` (default z-ai/glm-5.2, xhigh, cache, fp8+ quants, gmicloud/fp8);
  SETTINGS_TEMPLATE example. 15 config tests.
- P2 request plumbing (a9fccb1): opt-in `HighQualityRequest` {provider,reasoning,cache} threaded
  ScanFolderDeps→processFileCheck→ensembleStreaming→chatCompletionSimple (single-model path ONLY;
  provider survives the param filter; cache_control breakpoint on the system prompt; reasoning rides
  the ladder). Non-HQ calls byte-identical. Full suite 1211 green.
- P3 MCP tool (604fffc): `high_quality_scan` tool (scan_folder schema shared via `scanFolderSchemaProps`);
  dispatch uses `buildHighQualityProvider` + `highQualityScanRefusal` (paid-model fail-fast: refuses
  on non-openrouter / free_only / creditExhausted, never downgrades); `useEnsemble:false`,
  `modelOverride=hq.id`, `hqRequest` from config. LLM_TOOLS_SET + README count 39→40 / 16→17 + table row.
  Tests: 4+5+5 unit + 1 fail-fast integration + listTools; doc-consistency green.
- DEVIATION: NO `model-qualification/registry.ts` entry — the HQ model is FIXED/user-configured, not
  benchmark-qualified (the registry is only for auto-selected/swappable tools). Intentional.

**NEXT ACTION:** Phase 4 — CLI. Add a `high-quality-scan` subcommand to `mcp-server/src/cli.ts`
mirroring the `scan-folder` CLI command (same args), routing to the same `runScanFolder` core with
the HQ deps (modelOverride=hq.id + hqRequest + the `highQualityScanRefusal` gate). Then `npm run
build && lint && test`. Phase 5 = slash commands (pure `high-quality-scan` completes the 3 surfaces;
`_and_fix` = slash-only, reuse the existing opus parallel-fixer, force `LLM_EXT_FORCE_OPUS=1`).
Phase 6 = docs (bump README line ~114 command counts when P5 adds commands) + dogfood + final
full-suite + commit.

**Load-bearing VERIFIED facts (do not re-derive):**
- Single-model dispatch already exists: `ensembleStreaming` (index.ts:3159) has a `modelOverride`
  bypass (index.ts:3173-3175) → `chatCompletionWithRetry` → `chatCompletionSimple`. Setting
  `ScanFolderDeps.modelOverride` runs exactly ONE model per file. `getEnsembleModels()` returns
  `[]` unless `mode==="remote-ensemble"`, so a `remote` profile is already single-model.
- "max reasoning effort" = OpenRouter **`xhigh`** (the real ceiling; there is NO literal "max").
  Enum: `off|xhigh|high|medium|low` (index.ts:310). Config accepts `max` as an alias → `xhigh`.
- Provider routing / quantization / prompt-cache are **NOT plumbed anywhere today** (verified by
  grep). `provider` is a control field NOT in `FILTERABLE_REQUEST_FIELDS` (index.ts:396-417), so
  a `provider` set on `baseBody` survives the supported-params filter to the wire.
- Request bodies built at: `chatCompletionSimple` baseBody index.ts:1936-1942 (+reasoning 1978-2006);
  `chatCompletionJSON` baseBody index.ts:2169-2186. Headers index.ts:1337-1351.
- OpenRouter provider object (verified openrouter.ai/docs): `{ order:[slug...], only:[...],
  ignore:[...], allow_fallbacks:bool, require_parameters:bool, quantizations:[...], sort, max_price }`.
  A slug MAY carry a quant suffix → `"gmicloud/fp8"` is valid in `order`. quant values include
  `fp8, fp16, bf16, fp32, int8, int4` — "fp8 or higher" = `["fp8","fp16","bf16","fp32"]`.
- OpenRouter caching (verified): most providers auto-cache (OpenAI/Grok/DeepSeek/Gemini2.5/Groq/
  Moonshot, no flag). Anthropic/**Qwen**/Gemini-explicit need a `cache_control:{type:"ephemeral"}`
  breakpoint on a message content PART (array-of-parts form). We add the breakpoint on the SYSTEM
  prompt (the stable, repeated prefix across per-file calls) when `cache:true`. OpenRouter
  normalizes/strips it per-provider.
- Config lives PER-PROFILE (Settings is only `{active,profiles}`; `loadSettings()` drops top-level
  keys — config.ts:296-314). Mirror `tool_models` (Profile field config.ts:84, validation
  config.ts:569-601, null-tolerant). MUST add defaults to BOTH `generateDefaultSettings()`
  (config.ts:317-347) AND `SETTINGS_TEMPLATE` (config.ts:840-954).
- MCP tool = CORE tool: def in `tools/definitions.ts` (mirror `scan_folder` 519-587), dispatch
  `case "high_quality_scan":` in index.ts switch (mirror scan_folder case index.ts:5017-5037,
  reuse `runScanFolder` + `ScanFolderDeps`). `LLM_TOOLS_SET` membership gates request tracking.
- CLI: a top-level subcommand shim in `cli.ts main()` (mirror `security-scan` shim cli.ts:818-829)
  + a `TOOL_CATALOG` entry in `bin/llm-ext` (mirror security_scan bin/llm-ext:355-369) + a
  `printUsage()` synopsis line (cli.ts:686-763). bin name `llm-externalizer`→dist/cli.js.
- Slash surfaces: pure `high_quality_scan` = all THREE surfaces. `high_quality_scan_and_fix` =
  **slash-only** (GAP-11 / TRDD-a24b213c §C exemption: it fans out fixer subagents). Mirror
  `commands/llm-externalizer-scan-and-fix.md`; FORCE Opus via `LLM_EXT_FORCE_OPUS=1`; reuse the
  EXISTING parallel-fixer-opus agent (already verify-then-fix: opens cited file, traces flow,
  5-bucket classify, fixes only REAL bugs, lints, writes `.fixer.` summary).
- COST-SAFETY: `high_quality_scan` uses a PAID model. Under a `free_only` profile the airtight
  guard (TRDD-97ef8b63, index.ts:1380) already refuses non-`:free` models. The tool MUST fail
  fast with a CLEAR message ("high_quality_scan requires a paid model; not available under a
  free_only profile / auto-free-on-low-balance") instead of silently downgrading or spending.

**SUPERSEDED — do NOT carry forward:** none yet.

**Durable artifacts to read before acting:**
- `reports_dev/high-quality-scan/01-request-and-dispatch.md` (request bodies + scan dispatch, file:line)
- `reports_dev/high-quality-scan/02-config-and-surfaces.md` (config schema + 3-surface patterns)
- `reports_dev/high-quality-scan/03-fix-and-output.md` (scan-and-fix + fixer + output modes)
  (These are gitignored/ephemeral — every load-bearing fact is copied above so this TRDD stands alone.)

## Why

The default scan uses a cheap 3-model ensemble (breadth, low cost). For high-stakes audits a
user wants ONE strong reasoning model run at maximum effort with deterministic provider/quant
routing and caching — fewer, deeper, more trustworthy findings — and then an Opus pass that
verifies each finding against the source before fixing. This is a distinct mode, not a tweak to
the ensemble, so it ships as its own capability with its own config.

## Design

### D1 — Config (`high_quality_model`, per-profile)
New `HighQualityModel` interface + optional `Profile.high_quality_model`:
```ts
export interface HighQualityModel {
  id?: string;                 // default "z-ai/glm-5.2"
  reasoning_effort?: string;   // off|low|medium|high|xhigh|max ; "max"→"xhigh"; default "max"
  cache?: boolean;             // default true
  min_quantization?: string;   // default "fp8" → expands to ["fp8","fp16","bf16","fp32"]
  provider?: string;           // default "gmicloud/fp8" → provider.order=[...]
  allow_fallbacks?: boolean;   // default false (pin the preferred provider)
}
```
Resolution: built-in defaults fill any missing sub-field, so an empty/absent block still yields
the full GLM-5.2/xhigh/cache/fp8/gmicloud spec. `ResolvedProfile.highQualityModel` carries the
resolved concrete values. Validate with the null-tolerant object-shape pattern (reject non-object,
unknown keys, bad types; validate `reasoning_effort` against the enum+`max`). Add the default
block to BOTH default-settings copies. Add `high_quality_scan` to `TOOL_MODEL_REGISTRY` so it is a
valid `tool_models` key + benchmarkable.

### D2 — Request plumbing (provider + reasoning + cache), opt-in, zero behavior change
Thread an optional `hqRequest?: { provider?: object; reasoning?: ReasoningEffortSetting;
cache?: boolean }` (or discrete options) down the single-model dispatch chain:
`ScanFolderDeps.modelOverride` + new `ScanFolderDeps.hqRequest` → `processFileCheck` options →
`ensembleStreaming` options → `chatCompletionWithRetry` → `chatCompletionSimple`. In
`chatCompletionSimple`/`chatCompletionJSON`, when set: (a) `baseBody.provider = hqRequest.provider`
(survives the filter — control field); (b) reasoning ladder uses `hqRequest.reasoning` override
(Simple already honors `options.reasoning`; thread it through the scan path which currently does
NOT); (c) when `cache`, convert the system message to the array-of-parts form with a
`cache_control:{type:"ephemeral"}` breakpoint on the system content. ALL options default
undefined → existing chat/scan/ensemble behavior byte-for-byte unchanged. Add unit tests asserting
the exact wire body for the HQ path and that the non-HQ path is untouched.

### D3 — MCP tool `high_quality_scan` (core)
Mirror `scan_folder`'s inputSchema (folder_path, extensions, exclude_dirs, max_files, instructions,
instructions_files_paths, scan_secrets, redact_secrets, use_gitignore, answer_mode, redact_regex,
max_payload_kb) — i.e. ALL the same output-mode customizations. NO per-call model arg (the model +
knobs come from config "as usual", per the user). The `case "high_quality_scan":` resolves the HQ
config, builds `ScanFolderDeps` with `modelOverride = hq.id` + `hqRequest = {provider,reasoning,
cache}` + `useEnsemble:false`, then `runScanFolder`. Free_only pre-check → fail fast with a clear
message.

### D4 — CLI surface
`cli.ts` top-level `high-quality-scan` subcommand (parse the same flags, call the tool path) +
`printUsage()` line. `bin/llm-ext` `TOOL_CATALOG.high_quality_scan` entry (help only; dispatch is
by-name). Honor the same free_only fail-fast.

### D5 — Slash commands
- `commands/llm-externalizer-high-quality-scan.md` — thin doc wrapper over the one MCP tool (mirror
  security-scan.md: frontmatter `allowed-tools:[mcp__llm-externalizer__high_quality_scan]`,
  argument-hint, body documenting the config-driven model + the three surfaces).
- `commands/llm-externalizer-high-quality-scan-and-fix.md` — mirror scan-and-fix.md: scan with the
  HQ tool (answer_mode 0, hardcoded output_dir), then dispatch parallel fixers with
  `LLM_EXT_FORCE_OPUS=1` (every fixer = the opus verify-then-fix agent), join via
  `join_fixer_reports.py`. Carry the GAP-11 slash-only exemption note. NO `Read` in allowed-tools.

### D6 — Docs + help
README (tool table + a "High-quality scan" section), the relevant skills' help, CHANGELOG, and the
dogfood harness (`tests/dogfood/`) coverage for the new MCP tool + CLI + both slash commands.

## Phased plan (each phase: ≤5 files, then build+lint+test)
1. **Config** — config.ts (+ registry.ts) + config tests. [D1]
2. **Request plumbing** — index.ts request builders + dispatch chain options + request-overrides
   if needed; unit tests asserting the HQ wire body and the unchanged default path. [D2]
3. **MCP tool** — tools/definitions.ts + index.ts dispatch case + scan-folder/core.ts deps if
   needed; tool tests. [D3]
4. **CLI** — cli.ts + bin/llm-ext + printUsage; cli tests. [D4]
5. **Slash commands** — the two command .md files. [D5]
6. **Docs + dogfood + CHANGELOG**, full build+lint+test, dogfood ($0), commit. [D6]

## Test plan
- Config: parse/validate/resolve a profile with + without `high_quality_model`; defaults fill;
  bad sub-fields rejected; `max`→`xhigh`; `min_quantization` expansion.
- Request: HQ options produce exactly `provider`+`reasoning(xhigh)`+`cache_control` on the wire;
  absent options leave the body identical to today (regression guard).
- Tool wiring: `high_quality_scan` registered; dispatch builds single-model deps; free_only →
  fail-fast error (no spend).
- CLI: subcommand parses + routes; `bin/llm-ext` help entry present.
- Slash: both command files valid frontmatter; CPV/skill validation clean.
- Dogfood: $0 surface checks for the new surfaces.
- NO live paid calls (cost-safety). Live behavior of GLM-5.2/GMICloud is config-default, not tested
  with real spend.

## Constraints honored
Fail-fast (no silent free downgrade); no bloat (reuse runScanFolder + the existing opus fixer; no
new fixer agent); single source of truth (model+knobs from config); never relax the free_only
cost-safety guard; three-surface invariant (pure scan = 3 surfaces; _and_fix = slash-only per the
ratified GAP-11 exemption). Do NOT push (publish.py only).

## Approval log
- 2026-06-25T19:37:20+0200 — Authored. Tier 0 (in-scope feature the USER explicitly requested on
  llm-externalizer; reversible/local; no governance/baseline/release-to-prod). Implementing now per
  the standing go-on-yourself authorization. NOT pushing (awaits user approval).
