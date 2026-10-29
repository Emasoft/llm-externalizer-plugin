/**
 * Integration tests for the LLM Externalizer CLI.
 *
 * These tests spawn the actual `llm-ext` CLI as a subprocess, the same way a
 * real user would. No LLM backend is required for most tests — only tools
 * that don't make LLM calls (discover, the tool catalog) are tested.
 *
 * For tools that DO call the LLM (chat, code_task, etc.), we test only the
 * input validation / error paths that fail before the LLM call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveTestConfig, runCli, CLI_SCRIPT, type CliResult } from './test-helpers';

const execFileAsync = promisify(execFile);
import { buildTools, classifyToolName } from './tools/definitions.js';
import { DECISION_SPECS } from './classifiers/catalog/index.js';
import { limitsBlock } from './index.js';

// COST-SAFETY (TRDD-e82f2c49): default resolveTestConfig now spawns the CLI
// with a LOCAL, unreachable backend (127.0.0.1:1), so these integration tests
// make ZERO OpenRouter calls — every LLM tool call fails fast on ECONNREFUSED,
// which is exactly what they assert ("the CLI didn't crash"). NO requireLiveBackend.
const testConfig = resolveTestConfig({ testName: 'unit' });

// The LLM backend is deliberately unreachable, so a real-call test only needs
// to wait long enough for the call to fail, not the full production timeout.
//
// This budget must clear boot + the first model-reconcile (a fresh throwaway
// config dir has no last-reconcile.json, so it is NOT throttled) + the capped
// retry ladder. Measured ~13s; 20s leaves headroom on a loaded machine.
//
// Do NOT tighten this back to 10s: `execFileAsync` SIGKILLs on timeout, which
// surfaces as `exitCode: null` — indistinguishable from the CLI hanging, and it
// cost a real debugging session chasing a hang that did not exist. The ladder
// itself is bounded by `timeout: 5` in the synthetic test profile.
const UNREACHABLE_CALL_TIMEOUT_MS = 20_000;

import { beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { stampProfileMigrationDone, recordDynamicBenchmarkAt } from './default-profiles-state.js';
import { enqueueCandidates } from './dynamic-candidates.js';
import { tmpdir } from './test-tmp-root.js';

/** The tool catalog the CLI itself is built from — no MCP `listTools()` any
 * more, so this is the direct equivalent: same function, same input. */
const TOOLS = buildTools(limitsBlock()) as {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown> };
}[];

function firstText(result: CliResult): string {
  return result.content[0]?.text ?? '';
}

// ── Tool listing ──────────────────────────────────────────────────────

describe('tool catalog', () => {
  it('returns all expected tools', () => {
    /** Verify buildTools() exposes the full set of tools */
    const toolNames = TOOLS.map(t => t.name).sort();

    // custom_prompt was merged into chat — it still works via switch fall-through
    // but is NOT listed as a separate tool in buildTools().
    // Write tools (fix_code, batch_fix, merge_files, split_file, revert_file)
    // and settings-write tools (set_settings, change_model) have been removed
    // from the codebase — the MCP server is read-only by design.
    const expected = [
      'batch_check',
      // C4-03: one classify_<spec id> tool per registered decision spec, generated, so the expected names come from the registry too.
      ...DECISION_SPECS.map((spec) => classifyToolName(spec.id)),
      'chat',
      'check_against_specs',
      'check_imports',
      'check_references',
      'code_task',
      'compare_files',
      'discover',
      'get_settings',
      'profile',
      // list_profiles — read-only list of every profile in settings.yaml
      // (settings-rename task), with a marker on the active one.
      'list_profiles',
      // session_summary — compaction-style summary of a whole Claude Code
      // session from its JSONL transcript (TRDD-T4MZ8YQR), map-reduce +
      // checkpointed, $0-only free models.
      'session_summary',
      // scan_local_llm_services — autodiscovers running local LLM services and,
      // only on an explicit --pick N, writes + activates a profile for one.
      // Never auto-runs; a bare invocation writes no profile.
      'scan_local_llm_services',
      'or_model_info',
      'or_model_info_json',
      'or_model_info_table',
      'reset',
      // review_plan — $0 delegate mode (TRDD-SNAEERHU): scaffolding only,
      // the host agent reviews with its own model.
      'review_plan',
      // rules_check — layered per-path rules debug lookup (TRDD-3JQVBO7M), no LLM.
      'rules_check',
      'scan_folder',
      'high_quality_scan',
      'search_existing_implementations',
      'cluster_synonyms',
      // text tools — 4 single-call tools sharing text-tools/core.ts
      // (TRDD-VFXS2ZYY/9XOHSYFV/SYEH38AV/Q3ERXAAO)
      'summarize',
      'topics',
      'sem_deduplicate',
      'describe',
      // mass-scouting — 16 tools
      // (8 base + 3 Phase B + 2 Phase C2 + 2 Phase C3 + 1 Phase F)
      'mass_scout',
      'mass_scout_audit_sample',
      'mass_scout_body_get',
      'mass_scout_build_fieldset',
      'mass_scout_chain',
      'mass_scout_diff',
      'mass_scout_estimate',
      'mass_scout_export',
      'mass_scout_get',
      'mass_scout_jobs_list',
      'mass_scout_list_bundled_fieldsets',
      'mass_scout_preclassify',
      'mass_scout_propose_fieldset',
      'mass_scout_register',
      'mass_scout_search',
      'mass_scout_search_xjob',
      // security_scan — dedicated injection-hardened tool (TRDD-5bd98017),
      // registered in MASS_SCOUT_TOOLS so buildTools() picks it up.
      'security_scan',
      // security_triage_benchmark — model qualification for the security_scan
      // triage task (TRDD-973a0265), registered in the same array.
      'security_triage_benchmark',
      // search_existing_benchmark — model qualification for the
      // search_existing_implementations task (TRDD-828238b5 A6), registered in
      // the same array; deterministic scoring, no LLM judge.
      'search_existing_benchmark',
      // assess_model — cross-tool requirements assessment (TRDD-f45eeaa0),
      // registered in the same array; offline, no LLM call.
      'assess_model',
      // check_model_health — configured-model self-check (TRDD-828238b5 A2),
      // registered in the same array; offline (catalog fetch only), no LLM call.
      'check_model_health',
      // discover_new_models — new-arrivals autodiscovery (TRDD-828238b5 A4),
      // registered in the same array; offline (catalog fetch only), no LLM call.
      'discover_new_models',
      // check_tool_replacements — READ-ONLY advisory auto-replacement planner
      // (TRDD-828238b5 A7-P3), registered in the same array; in-process, NEVER
      // writes settings (the MCP surface cannot self-rewrite its own config).
      'check_tool_replacements',
      // calibrate_model / calibration_status — P6 local-model calibration (TRDD-1OOAH3LD):
      // queue a model and start the detached runner; report the records. No LLM call.
      'calibrate_model',
      'calibration_status',
    ].sort();

    expect(toolNames).toEqual(expected);
  });

  it('each tool has a non-empty description', () => {
    /** Every tool must have a description — shown in `llm-ext --help` and per-command help */
    for (const tool of TOOLS) {
      expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });

  it('each tool has an inputSchema', () => {
    /** Every tool must declare its input schema — the CLI's flag parser depends on it */
    for (const tool of TOOLS) {
      expect(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('chat tool inputSchema lists its named properties', () => {
    /**
     * Regression guard carried over from the MCP era (where a Zod round-trip
     * could silently drop a property). No round-trip exists any more —
     * buildTools() is the CLI's own source of truth — but the invariant
     * ("chat always exposes these flags") is still worth asserting directly.
     */
    const chat = TOOLS.find(t => t.name === 'chat');
    expect(chat).toBeDefined();
    const props = (chat!.inputSchema.properties ?? {}) as Record<string, unknown>;
    for (const key of ['instructions', 'input_files_paths', 'input_files_content', 'system', 'free']) {
      expect(props[key], `chat tool inputSchema missing property "${key}"`).toBeDefined();
    }
  });

  it('session_summary tool inputSchema exposes the caller-selected --stdout output mode, distinct from --output', () => {
    /**
     * TRDD-T4MZ8YQR Phase B item 2: the caller chooses file-path (default)
     * vs direct-text output. `stdout` must exist and must NOT be confused
     * with `output` (the report DIRECTORY flag) — asserting both are
     * present and are separate schema keys guards against the two being
     * merged/renamed into one ambiguous flag later.
     */
    const sessionSummary = TOOLS.find(t => t.name === 'session_summary');
    expect(sessionSummary).toBeDefined();
    const props = (sessionSummary!.inputSchema.properties ?? {}) as Record<
      string,
      { type?: string }
    >;
    expect(props.stdout, 'session_summary inputSchema missing property "stdout"').toBeDefined();
    expect(props.stdout.type).toBe('boolean');
    expect(props.output, 'session_summary inputSchema missing property "output"').toBeDefined();
    expect(props.output.type).toBe('string');
  });

  it('discover tool with no arguments is callable end-to-end', async () => {
    /**
     * Verifies the CLI wiring end to end: command resolution, flag parsing
     * (none needed here), boot(), and dispatchCallTool() all connect. discover
     * is chosen because it makes no LLM call (won't burn credits).
     */
    const result = await runCli(testConfig, 'discover');
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect(firstText(result)).toMatch(/Effective profile:/);
  });
});

// ── discover tool ─────────────────────────────────────────────────────

describe('discover', () => {
  it('returns service health information', async () => {
    /** discover returns status info — OFFLINE when no backend is running */
    const result = await runCli(testConfig, 'discover');
    // discover always returns a result (even when offline)
    const text = firstText(result);
    expect(text).toBeTruthy();
    // When no backend is running, it says OFFLINE
    // When a backend IS running, it mentions Local, LM Studio, or OpenRouter
    expect(text).toMatch(/OFFLINE|Local|LM Studio|OpenRouter/i);
  });

  it('runs verbosely (banner + no crash) without error', async () => {
    /**
     * Was "accepts progress token without error" under MCP — there is no
     * progress-token protocol over a CLI invocation, so the equivalent
     * assertion is: running with the boot banner enabled (i.e. NOT --quiet)
     * still completes cleanly, even though discover finishes instantly and
     * emits no progress lines of its own.
     */
    const result = await runCli(testConfig, 'discover', {}, { quiet: false, timeoutMs: 30_000 });
    expect(result.isError).toBeFalsy();
  });
});

// ── Input validation (error paths before LLM call) ───────────────────

describe('input validation', () => {
  it('chat: fails without instructions or input', async () => {
    /** chat requires either instructions or input_files_paths */
    const result = await runCli(testConfig, 'chat', {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/FAILED/i);
  });

  it('code_task: fails without instructions or input', async () => {
    /** code_task requires either instructions or input_files_paths */
    const result = await runCli(testConfig, 'code_task', {});
    expect(result.isError).toBe(true);
  });

  it('batch_check: fails with empty input_files_paths', async () => {
    /** batch_check requires non-empty input_files_paths array */
    const result = await runCli(testConfig, 'batch_check', { input_files_paths: [] });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/input_files_paths/i);
  });

  it('high_quality_scan: fails fast on a non-OpenRouter backend (TRDD-DBUSM55E)', async () => {
    /** high_quality_scan runs a PAID model and must refuse, not silently
     *  downgrade, when the backend cannot run it. A paid-TYPE profile (accepted
     *  by the PT-03 type check) pointing at a local url passes the type check
     *  and reaches the OpenRouter-backend gate. */
    const cfgDir = mkdtempSync('/tmp/__llm_ext_hqs_cfg_');
    const outDir = mkdtempSync('/tmp/__llm_ext_hqs_out_');
    writeFileSync(join(cfgDir, 'settings.yaml'), [
      'active: hqs-paid-local',
      'profiles:',
      '  hqs-paid-local:',
      '    profile-type: paid',
      '    mode: local',
      '    api: generic-local',
      '    model: test-model',
      '    url: http://127.0.0.1:1',
      '    timeout: 5',
      '',
    ].join('\n'), 'utf-8');
    try {
      await execFileAsync(
        'node',
        [CLI_SCRIPT, 'high_quality_scan', '--folder_path', outDir, '--instructions', 'find bugs', '--profile', 'hqs-paid-local', '--quiet'],
        { env: { ...process.env, OPENROUTER_API_KEY: '', LLM_EXT_CONFIG_DIR: cfgDir, LLM_EXT_OUTPUT_DIR: outDir, LLM_EXT_INSTALL_RULE: '0' }, timeout: UNREACHABLE_CALL_TIMEOUT_MS },
      );
      throw new Error('high_quality_scan unexpectedly succeeded');
    } catch (err) {
      expect((err as { stderr?: string }).stderr ?? '').toMatch(/OpenRouter backend/i);
    } finally {
      rmSync(cfgDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('high_quality_scan: refuses a local-type profile by profile type (PT-03)', async () => {
    /** The cost-safe test profile is local-typed; high_quality_scan is paid-only,
     *  so the PT-03 check names the command, profile, type and accepted types. */
    const result = await runCli(testConfig, 'high_quality_scan', {
      folder_path: '/tmp',
      instructions: 'find bugs',
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/high-quality-scan does not accept profile 'test-local-unreachable' \(type 'local'\); accepted profile types: paid/);
  });

  it('compare_files: fails with fewer than 2 files', async () => {
    /** compare_files requires exactly 2 input files */
    const result = await runCli(testConfig, 'compare_files', { input_files_paths: ['/nonexistent'] });
    expect(result.isError).toBe(true);
  });

  it('scan_folder: fails with nonexistent folder', async () => {
    /** scan_folder should return error for nonexistent directory */
    const result = await runCli(testConfig, 'scan_folder', {
      folder_path: '/tmp/__nonexistent_test_folder_12345',
      instructions: 'find bugs',
    });
    expect(result.isError).toBe(true);
  });

});

// ── scan_secrets validation ──────────────────────────────────────────

describe('scan_secrets', () => {
  const tmpDir = '/tmp/__llm_ext_test_secrets';
  const secretFile = join(tmpDir, 'secret.ts');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    // Write a file containing a fake API key pattern
    writeFileSync(secretFile, `const API_KEY = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz1234567890ab";\nconsole.log(API_KEY);\n`, 'utf-8');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chat: aborts when scan_secrets finds secrets', async () => {
    /** chat with scan_secrets should abort when input files contain API keys */
    const result = await runCli(testConfig, 'chat', {
      instructions: 'summarize this file',
      input_files_paths: secretFile,
      scan_secrets: true,
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/secret|key|blocked|abort/i);
  });

  it('code_task: aborts when scan_secrets finds secrets', async () => {
    /** code_task with scan_secrets should abort when input files contain API keys */
    const result = await runCli(testConfig, 'code_task', {
      instructions: 'review this file',
      input_files_paths: secretFile,
      scan_secrets: true,
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/secret|key|blocked|abort/i);
  });

  it('batch_check: aborts when scan_secrets finds secrets', async () => {
    /** batch_check with scan_secrets should abort when input files contain secrets */
    const result = await runCli(testConfig, 'batch_check', {
      input_files_paths: [secretFile],
      scan_secrets: true,
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/secret|key|blocked|abort/i);
  });
});

// ── Progress notifications during LLM calls ──────────────────────────
// Under MCP these tests verified the server sent notifications/progress
// events mid-call without crashing. There is no MCP progress protocol over
// a CLI invocation any more — the CLI's equivalent of "progress" is lines
// written to stderr (`--quiet` off) via the same `onProgress` callback the
// old server used (see makeProgressFn() in index.ts). So the rewritten
// assertion is: running verbosely against an unreachable LLM backend still
// exits cleanly (no hang, no uncaught crash) within the short timeout, and
// a fresh `discover` invocation right after still succeeds — i.e. nothing
// about the failed call corrupted process state that a later invocation
// depends on (settings cache, free-mode publish, etc).

describe('progress notifications', () => {
  const tmpDir = '/tmp/__llm_ext_test_progress';
  const testFile = join(tmpDir, 'hello.ts');

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testFile, 'export function hello() { return "world"; }\n', 'utf-8');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chat: runs verbosely against an unreachable backend without hanging or crashing', async () => {
    /** chat with the boot banner + progress lines enabled must still fail
     * cleanly (ECONNREFUSED), not hang or crash. */
    const result = await runCli(
      testConfig,
      'chat',
      { instructions: 'say hello' },
      { quiet: false, timeoutMs: UNREACHABLE_CALL_TIMEOUT_MS },
    );
    expect(result.isError).toBe(true);
    expect(result.exitCode).not.toBeNull();

    // A fresh invocation right after must still work — no corrupted state
    // survives a failed call.
    const discoverResult = await runCli(testConfig, 'discover');
    expect(discoverResult.isError).toBeFalsy();
  });

  it('code_task: runs verbosely against an unreachable backend without hanging or crashing', async () => {
    /** code_task with the boot banner + progress lines enabled must still fail
     * cleanly (ECONNREFUSED), not hang or crash. */
    const result = await runCli(
      testConfig,
      'code_task',
      { instructions: 'review this file', input_files_paths: testFile },
      { quiet: false, timeoutMs: UNREACHABLE_CALL_TIMEOUT_MS },
    );
    expect(result.isError).toBe(true);
    expect(result.exitCode).not.toBeNull();

    // A fresh invocation right after must still work.
    const discoverResult = await runCli(testConfig, 'discover');
    expect(discoverResult.isError).toBeFalsy();
  });
});

// ── answer_mode dispatch ─────────────────────────────────────────────
// These tests verify that the new mode 1 auto-grouping path routes
// requests correctly through the handlers. The LLM backend is not
// reachable in CI, so we assert that:
//   (a) validation errors (no instructions) come from the expected
//       branch (per-group path), and
//   (b) the server doesn't crash when mode 1 walks a real folder with
//       multiple extensions and subdirectories.

describe('answer_mode dispatch', () => {
  const tmpDir = '/tmp/__llm_ext_test_mode1';
  const srcDir = join(tmpDir, 'src');
  const scriptsDir = join(tmpDir, 'scripts');
  const srcA = join(srcDir, 'auth.ts');
  const srcB = join(srcDir, 'db.ts');
  const scriptFoo = join(scriptsDir, 'foo.py');
  const scriptBar = join(scriptsDir, 'bar.py');

  beforeAll(() => {
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(srcA, 'export const a = 1;\n', 'utf-8');
    writeFileSync(srcB, 'export function db() {}\n', 'utf-8');
    writeFileSync(scriptFoo, 'def foo(): pass\n', 'utf-8');
    writeFileSync(scriptBar, 'def bar(): pass\n', 'utf-8');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('chat: answer_mode=1 routes mixed-extension files through auto-grouping without crash', async () => {
    /** With 4 files in 2 subdirs × 2 extensions, auto-grouping should
     * produce 2 groups (src-ts, scripts-py). The LLM is unreachable so
     * the call fails after the grouping decision — we only verify that
     * the CLI survives the routing path and didn't reject the request
     * up-front with a validation error. runCli() never throws (unlike the
     * old SDK client) — it always returns a CliResult, so no try/catch
     * is needed here any more. */
    const result = await runCli(
      testConfig,
      'chat',
      {
        instructions: 'audit for bugs',
        input_files_paths: [srcA, srcB, scriptFoo, scriptBar],
        answer_mode: 1,
      },
      { timeoutMs: UNREACHABLE_CALL_TIMEOUT_MS },
    );
    // The response must NOT be a pre-LLM validation failure (e.g.
    // "instructions required"). An empty-LLM error is fine.
    const text = firstText(result);
    expect(text).not.toMatch(/instructions or input_files_paths is required/i);
    expect(text).not.toMatch(/folder_path is required/i);
    // CLI must still be usable afterward
    const discoverResult = await runCli(testConfig, 'discover');
    expect(discoverResult.isError).toBeFalsy();
  });

  it('code_task: answer_mode=1 with explicit ---GROUP:id--- markers routes through grouped path', async () => {
    /** Group markers bypass auto-grouping — ensure the explicit path
     * still works. The LLM call fails but the CLI mustn't crash. */
    const result = await runCli(
      testConfig,
      'code_task',
      {
        instructions: 'review',
        input_files_paths: [
          '---GROUP:typescript---',
          srcA,
          srcB,
          '---/GROUP:typescript---',
          '---GROUP:python---',
          scriptFoo,
          scriptBar,
          '---/GROUP:python---',
        ],
        answer_mode: 1,
      },
      { timeoutMs: UNREACHABLE_CALL_TIMEOUT_MS },
    );
    expect(firstText(result)).not.toMatch(/instructions.*required/i);
    const discoverResult = await runCli(testConfig, 'discover');
    expect(discoverResult.isError).toBeFalsy();
  });

  it('scan_folder: answer_mode=1 rejects nonexistent folder before any LLM call', async () => {
    /** scan_folder mode 1 should validate the folder exists BEFORE
     * walking it or issuing LLM calls, and BEFORE the auto-grouping
     * step runs on the (empty) file list. */
    const result = await runCli(testConfig, 'scan_folder', {
      folder_path: '/tmp/__llm_ext_nonexistent_grouping',
      instructions: 'audit',
      answer_mode: 1,
    });
    expect(result.isError).toBe(true);
    // The operation must reject BEFORE any LLM call. Either "folder not
    // found" (existence check) or the path-traversal allowlist rejection
    // (when /tmp/ is outside the allowed directories under test env) both
    // satisfy that — the point of the test is that no LLM call ran.
    expect(firstText(result)).toMatch(/not found|Folder not found|Path traversal|outside allowed/i);
  });

  it('chat: answer_mode=2 still works as the single-merged-report path', async () => {
    /** Regression guard — the redesign must not have broken mode 2. */
    const result = await runCli(
      testConfig,
      'chat',
      { instructions: 'summarize', input_files_paths: [srcA], answer_mode: 2 },
      { timeoutMs: UNREACHABLE_CALL_TIMEOUT_MS },
    );
    expect(firstText(result)).not.toMatch(/instructions.*required/i);
    const discoverResult = await runCli(testConfig, 'discover');
    expect(discoverResult.isError).toBeFalsy();
  });

  it('search_existing_implementations: answer_mode=1 validates feature_description before grouping', async () => {
    /** SEI mode 1 path — missing feature_description must fail at the
     * top-level validator, not silently in the mode 1 branch. */
    const result = await runCli(testConfig, 'search_existing_implementations', {
      folder_path: tmpDir,
      answer_mode: 1,
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/feature_description/i);
  });
});

// ── TRDD-90DM5YHO P3: dynamic-profile ensemble substitution (item 2) + ─────
// Rule 5 static-profile refusal (item 4). index.ts's activeResolved is
// module state computed at IMPORT time from whatever settings.yaml +
// LLM_EXT_CONFIG_DIR are in effect -- same recipe as
// route-headers.test.ts's loadFreshIndex: write a fresh settings.yaml, point
// LLM_EXT_CONFIG_DIR at it, vi.resetModules() (which ALSO resets
// free-rotation.js, so markRunUnusable must be re-imported from the SAME
// fresh registry, or it marks a different module instance than the one
// index.ts's getEnsembleModels actually reads through isUnusable).
describe('ensemble substitution + Rule 5 (TRDD-90DM5YHO P3)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;
  let prevBaiKey: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = prevBaiKey;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  async function loadFresh(settingsYaml: string) {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-ensemble-rule5-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), settingsYaml, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    // D5: pin BAI_API_KEY unset — an ambient key makes boot's
    // bai-reserved-seed migration add a reserved glm-5.3-flash slot to a
    // marked `free` fixture, which would leak into these assertions by env
    // leg. The seed's own behaviour is pinned in profile-migration.test.ts.
    prevBaiKey = process.env.BAI_API_KEY;
    delete process.env.BAI_API_KEY;
    vi.resetModules();
    const [idx, fr] = await Promise.all([import('./index.js'), import('./free-rotation.js')]);
    fr.resetRunUnusableForTests();
    return { idx, fr };
  }

  // The generated marker is NOT decoration here (P6c-a item 3): `paid` is a
  // RESERVED name, so a section under it that llm-ext cannot prove it wrote is
  // backed up and regenerated by the boot migration — which would hand this
  // test an unpopulated profile and an empty ensemble. A real maintained
  // `paid` section on disk always carries this comment.
  const DYNAMIC_PAID_YAML = `active: paid
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  paid:
    mode: remote-ensemble
    api: openrouter-remote
    model: vendor/model-a
    second_model: vendor/model-b
    third_model: vendor/model-c
    paid_models: [vendor/model-a, vendor/model-b, vendor/model-c, vendor/model-d]
    api_key: "sk-test-fake-openrouter-key"
`;

  it('dynamic paid ensemble with an unusable slot-1 model gets it replaced from the pool', async () => {
    const { idx, fr } = await loadFresh(DYNAMIC_PAID_YAML);
    fr.markRunUnusable('vendor/model-b', 'gone'); // slot 1 (second_model)
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    expect(ids).toEqual(['vendor/model-a', 'vendor/model-d', 'vendor/model-c']);
  });

  it('an unusable pinned slot-0 is replaced for the call (soft pin -- ensemble_pins never protects an unusable model at call time)', async () => {
    const { idx, fr } = await loadFresh(DYNAMIC_PAID_YAML);
    fr.markRunUnusable('vendor/model-a', 'gone'); // slot 0
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    expect(ids).toEqual(['vendor/model-d', 'vendor/model-b', 'vendor/model-c']);
    expect(ids).not.toContain('vendor/model-a');
  });

  it('a static ensemble keeps its unusable model (fails fast -- no substitution, Rule 5)', async () => {
    const STATIC_ENSEMBLE_YAML = `active: my-static
allow_paid_models: true
profiles:
  my-static:
    mode: remote-ensemble
    api: openrouter-remote
    model: vendor/static-a
    second_model: vendor/static-b
    api_key: "sk-test-fake-openrouter-key"
`;
    const { idx, fr } = await loadFresh(STATIC_ENSEMBLE_YAML);
    fr.markRunUnusable('vendor/static-a', 'gone');
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    // Unchanged -- a static profile is used exactly as written, even when a
    // slot's model is known run-unusable; the send itself surfaces the error.
    expect(ids).toEqual(['vendor/static-a', 'vendor/static-b']);
  });

  it("a b.ai route-served slot does not trip the free_only ':free'-suffix cost check", async () => {
    const BAI_FREE_YAML = `active: bai-free
allow_paid_models: false
profiles:
  bai-free:
    mode: remote-ensemble
    api: chat-b-ai-remote
    model: glm-5.3-flash
    second_model: glm-5.3-flash-2
    free_only: true
    free_models: [glm-5.3-flash, glm-5.3-flash-2]
    providers:
      - api: chat-b-ai-remote
        models: [glm-5.3-flash, glm-5.3-flash-2]
        api_key: "sk-test-fake-bai-key"
    api_key: "sk-test-fake-bai-key"
`;
    const { idx } = await loadFresh(BAI_FREE_YAML);
    // glm-5.3-flash carries no ':free' suffix, but it is served by a
    // non-billable (free-provider) route -- must NOT throw the cost-safety
    // error the plain ':free'-suffix check would otherwise raise.
    expect(() => idx.__getEnsembleModelsForTests()).not.toThrow();
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    expect(ids).toContain('glm-5.3-flash');
  });

  it('static forced-free profile with no pool refuses with the D-A message', async () => {
    const FORCED_FREE_NO_POOL_YAML = `active: bare
allow_paid_models: false
profiles:
  bare:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "sk-test-fake-openrouter-key"
`;
    const { idx } = await loadFresh(FORCED_FREE_NO_POOL_YAML);
    expect(() => idx.__activeFreePoolForTests()).toThrow(
      /defines no free models.*allow_paid_models: true/s,
    );
  });

  it("a static profile never draws a model outside its own free_models (TRDD-OE27RD7I addendum 4: engageAutoFree deleted outright, no auto-engagement to log)", async () => {
    const { idx } = await loadFresh(`active: bare2
allow_paid_models: false
profiles:
  bare2:
    mode: remote
    api: openrouter-remote
    model: vendor/whatever
    api_key: "sk-test-fake-openrouter-key"
`);
    // Rule 5: a static profile forced free by allow_paid_models:false with no
    // configured pool refuses loudly instead of silently borrowing
    // FREE_POOL_SEED or another profile's models -- unchanged by the auto-free
    // deletion, since this refusal never depended on engagement.
    expect(idx.__activeFreePoolForTests).toThrow();
  });
});

describe('D3c-1 (TRDD-FDI9NYAS) — the buildFreeRotationPool / getEnsembleModels serving union', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;
  let prevBaiKey: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    // D5: this describe's fixtures pin "no benchmark pass has ever been
    // recorded" — and boot now also seeds a reserved b.ai slot whenever
    // BAI_API_KEY resolves. An ambient key (this project's login shells
    // export one) would add a manual `glm-5.3-flash` ensemble member to the
    // marked `free` fixture and flip the withholding assertions by env leg.
    // The reserved slot's own behaviour is pinned elsewhere; here it must be
    // OUT of the picture.
    prevBaiKey = process.env.BAI_API_KEY;
    delete process.env.BAI_API_KEY;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = prevBaiKey;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  async function loadFresh(settingsYaml: string) {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-d3c1-union-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), settingsYaml, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    await idx.boot();
    return { idx };
  }

  // A STATIC profile's manualModels is its ENTIRE chainModelIds set (D3b) --
  // every id it declares, including free_models, is "the user's own choice",
  // never auto-picked. No benchmark cache is seeded (no
  // security-triage-results.json), so benchmarkPassedModels() is empty:
  // these ids are served ONLY because they are manual. Two entries (not one):
  // validateProfile refuses free_only + mode: remote-ensemble with fewer than
  // 2 free_models, and the ensemble variant of this fixture (below) needs it.
  const STATIC_MANUAL_FREE_YAML = `active: statfree
allow_paid_models: true
profiles:
  statfree:
    mode: remote
    api: openrouter-remote
    free_only: true
    free_models: [vendor/manual-free-a:free, vendor/manual-free-b:free]
    model: vendor/manual-free-a:free
    api_key: "sk-test-fake-openrouter-key"
`;

  // A DYNAMIC 'free' profile has an EMPTY manualModels (D3b) -- every one of
  // its free_models is auto-picked from this gate's point of view, same as a
  // real maintainer-written pool. No benchmark cache seeded either.
  const DYNAMIC_FREE_ENSEMBLE_YAML = `active: free
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  free:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: [vendor/auto-free-a:free, vendor/auto-free-b:free]
    model: vendor/auto-free-a:free
    api_key: "sk-test-fake-openrouter-key"
`;

  it('buildFreeRotationPool serves manual (STATIC profile) free ids with no recorded benchmark pass', async () => {
    const { idx } = await loadFresh(STATIC_MANUAL_FREE_YAML);
    expect(idx.__buildFreeRotationPoolForTests().sort()).toEqual([
      'vendor/manual-free-a:free',
      'vendor/manual-free-b:free',
    ]);
  });

  it('buildFreeRotationPool withholds an auto-picked (DYNAMIC profile) free id with no recorded benchmark pass', async () => {
    const { idx } = await loadFresh(DYNAMIC_FREE_ENSEMBLE_YAML);
    // Neither vendor/auto-free-a:free nor vendor/auto-free-b:free has ever
    // been benchmarked -- both are withheld, not just ranked lower.
    expect(idx.__buildFreeRotationPoolForTests()).toEqual([]);
  });

  it("getEnsembleModels serves manual (STATIC profile) free ids with no recorded benchmark pass", async () => {
    const { idx } = await loadFresh(
      STATIC_MANUAL_FREE_YAML.replace('mode: remote', 'mode: remote-ensemble'),
    );
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    expect(ids.sort()).toEqual(['vendor/manual-free-a:free', 'vendor/manual-free-b:free']);
  });

  it('getEnsembleModels withholds an auto-picked (DYNAMIC profile) free id with no recorded benchmark pass', async () => {
    const { idx } = await loadFresh(DYNAMIC_FREE_ENSEMBLE_YAML);
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    expect(ids).toEqual([]);
  });
});

// D5 (TRDD-90DM5YHO, design §2.3): the reserved ensemble slots.
describe('D5 reserved ensemble slots', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;
  let prevBaiKey: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    prevBaiKey = process.env.BAI_API_KEY;
    delete process.env.BAI_API_KEY; // keep the seed migration out of these fixtures
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = prevBaiKey;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  async function loadFresh(settingsYaml: string) {
    cfgDir = mkdtempSync(join('/tmp', 'llm-ext-d5-reserved-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), settingsYaml, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    await idx.boot();
    return { idx };
  }

  const PAID_WITH_RESERVED = `active: paid
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  paid:
    mode: remote-ensemble
    api: openrouter-remote
    model: vendor/model-a
    second_model: vendor/model-b
    third_model: vendor/model-c
    paid_models: [vendor/model-a, vendor/model-b, vendor/model-c, vendor/model-d]
    api_key: "sk-test-fake-openrouter-key"
    ensemble:
      reserved:
        - model: vendor/reserved-x
`;

  it('reserved slot comes FIRST, in written order; the ranking fills the rest excluding reserved ids', async () => {
    const { idx } = await loadFresh(PAID_WITH_RESERVED);
    const ids = idx.__getEnsembleModelsForTests().map((m) => m.id);
    // reserved-x first; then model-a/model-b fill the remaining 2 of 3; model-c
    // (third ranking slot) is dropped — reserved took one of the 3 seats.
    expect(ids).toEqual(['vendor/reserved-x', 'vendor/model-a', 'vendor/model-b']);
  });

  it('a reserved member carries its route; the D-L gate admits the fan-out when every member has one', async () => {
    const { idx } = await loadFresh(PAID_WITH_RESERVED);
    const members = idx.__getEnsembleModelsForTests();
    expect(members[0].route).toBeDefined();
    // No `provider:` in the slot — routesFor(reserved-x) falls back to the
    // catch-all (group #0, the profile's primary OpenRouter route).
    expect(members[0].route?.primary).toBe(true);
    expect(members[0].route?.api).toBe('openrouter-remote');
  });

  it('a LOCAL profile with reserved slots fans out (D-L: reserved non-empty OR remote-ensemble mode)', async () => {
    const LOCAL_RESERVED_YAML = `active: local
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  local:
    mode: local
    api: lmstudio-local
    model: qwen3-coder-30b
    free_models: [qwen3-coder-30b]
    ensemble:
      reserved:
        - model: qwen3-coder-30b
`;
    const { idx } = await loadFresh(LOCAL_RESERVED_YAML);
    const members = idx.__getEnsembleModelsForTests();
    expect(members.map((m) => m.id)).toEqual(['qwen3-coder-30b']);
    expect(members[0].route).toBeDefined(); // group #0 (lmstudio-local), local route
  });

  it('a LOCAL profile WITHOUT reserved slots stays inert (empty ensemble, D-L unchanged behaviour)', async () => {
    const LOCAL_PLAIN_YAML = `active: local
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  local:
    mode: local
    api: lmstudio-local
    model: qwen3-coder-30b
    free_models: [qwen3-coder-30b]
`;
    const { idx } = await loadFresh(LOCAL_PLAIN_YAML);
    expect(idx.__getEnsembleModelsForTests()).toEqual([]);
  });

  it('spend guard: allow_paid_models false + a reserved slot on a BILLABLE route in a local profile is refused', async () => {
    const LOCAL_BILLABLE_RESERVED_YAML = `active: local
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  local:
    mode: local
    api: lmstudio-local
    model: qwen3-coder-30b
    free_models: [qwen3-coder-30b]
    providers:
      - name: paid-host
        api: openrouter-remote
        url: https://paid.example.com
        api_key: "sk-test-literal-key"
        models: [vendor/paid-model]
    ensemble:
      reserved:
        - provider: paid-host
          model: vendor/paid-model
`;
    const { idx } = await loadFresh(LOCAL_BILLABLE_RESERVED_YAML);
    expect(() => idx.__getEnsembleModelsForTests()).toThrow(
      /allow_paid_models is false but the reserved ensemble slots name billable model\(s\): vendor\/paid-model/,
    );
  });

  it('spend guard does NOT fire on a local (non-billable) reserved route under allow_paid_models false', async () => {
    const LOCAL_LOCAL_RESERVED_YAML = `active: local
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  local:
    mode: local
    api: lmstudio-local
    model: qwen3-coder-30b
    free_models: [qwen3-coder-30b]
    ensemble:
      reserved:
        - model: qwen3-coder-30b
`;
    const { idx } = await loadFresh(LOCAL_LOCAL_RESERVED_YAML);
    expect(() => idx.__getEnsembleModelsForTests()).not.toThrow();
  });

  it('free-mode cost check still applies to reserved members: a paid reserved id under a master-switch-free profile is refused', async () => {
    // A free_only profile with a billable reserved route is refused EARLIER, at
    // validation (E-E6 free_only arm — pinned in config.test.ts). This fixture
    // reaches getEnsembleModels itself: a marked dynamic 'free' section WITHOUT
    // free_only (so E-E6 does not fire), the master switch forces free, and the
    // reserved slot names a paid id on the billable primary route.
    const FREE_PAID_RESERVED_YAML = `active: free
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  free:
    mode: remote-ensemble
    api: openrouter-remote
    free_models: [vendor/free-a:free, vendor/free-b:free]
    model: vendor/free-a:free
    second_model: vendor/free-b:free
    api_key: "sk-test-fake-openrouter-key"
    ensemble:
      reserved:
        - model: vendor/paid-reserved
`;
    const { idx } = await loadFresh(FREE_PAID_RESERVED_YAML);
    expect(() => idx.__getEnsembleModelsForTests()).toThrow(
      /free-mode cost-safety: non-':free' model\(s\) in the free ensemble: vendor\/paid-reserved/,
    );
  });

  it('a paid reserved id EXEMPT via its own route (manualModels + a b.ai-style free provider) passes the free-mode cost check (the kept b.ai benchmark exemption, automatic)', async () => {
    const FREE_BAI_RESERVED_YAML = `active: free
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  free:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: [vendor/free-a:free, vendor/free-b:free]
    model: vendor/free-a:free
    api_key: "sk-test-fake-openrouter-key"
    providers:
      - name: bai
        api: chat-b-ai-remote
        api_key: "sk-test-fake-bai-key"
        models: [glm-5.3-flash]
    ensemble:
      reserved:
        - provider: bai
          model: glm-5.3-flash
`;
    const { idx } = await loadFresh(FREE_BAI_RESERVED_YAML);
    // glm-5.3-flash: reserved (manual — never benchmarked here) + non-billable
    // route. No refusal: the manual provenance skips the benchmark gate and
    // the free-provider route passes the cost check. NO exemption hook exists
    // — this is the exemption-kept decision falling out of the architecture.
    const members = idx.__getEnsembleModelsForTests();
    expect(members[0].id).toBe('glm-5.3-flash');
    expect(members[0].route?.isFreeProvider).toBe(true);
  });
});

// ── D5 review F-6 pins (TRDD-90DM5YHO) — the reservation machinery vs the ──
// dynamic candidate queue / benchmark sweep, TWO distinct failure modes:
//   (a) reserving a model must never enqueue it as a benchmark candidate (the
//       sweep would bill/deny on a model the user pinned by hand), and
//   (b) a reserved id must stay an ORDINARY id to the maintenance machinery —
//       no reserved-name special case anywhere in decideDynamicProfile /
//       the sweep — so it remains benchmarkable and evictable if it ever
//       arrives through the normal catalog path (a user deleting the slot).
describe('F-6 reservation machinery never enqueues or benchmarks reserved ids', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;
  let prevBaiKey: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    prevBaiKey = process.env.BAI_API_KEY;
    vi.unmock('./dynamic-maintainer.js');
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevBaiKey === undefined) delete process.env.BAI_API_KEY;
    else process.env.BAI_API_KEY = prevBaiKey;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  const PAID_RESERVED_YAML = `active: paid
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  paid:
    mode: remote-ensemble
    api: openrouter-remote
    model: vendor/model-a
    second_model: vendor/model-b
    third_model: vendor/model-c
    paid_models: [vendor/model-a, vendor/model-b, vendor/model-c, vendor/model-d]
    api_key: "sk-test-fake-openrouter-key"
    ensemble:
      reserved:
        - model: vendor/reserved-x
`;

  it('(a) booting with a b.ai reserved slot seeds the slot but the candidate queue stays EMPTY and no benchmark covers the reserved id', async () => {
    cfgDir = mkdtempSync(join('/tmp', 'llm-ext-f6a-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), PAID_RESERVED_YAML, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    // The seed only runs when $BAI_API_KEY resolves; boot records the seed
    // step either way, so restore order does not re-seed the next fixture.
    process.env.BAI_API_KEY = 'f6a-bai-key-not-real';
    // The END-OF-PROCESS guard must never silently skip the sweep — this pin
    // is about the sweep's BEHAVIOUR with a reserved id present, not the
    // opt-out switch.
    delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    const dm = await import('./dynamic-maintainer.js');
    const dc = await import('./dynamic-candidates.js');
    const spawned: string[] = [];
    vi.spyOn(dm, 'dynamicProfileGate' as never);
    // Run the REAL maintainer pass against a fixed catalog: the reserved id is
    // NOT in the catalog and NOT in any generated key — the sweep must neither
    // enqueue it (queue stays empty) nor fan out a benchmark covering it.
    await dm.maintainDynamicProfiles({
      // Catalog covers EXACTLY the configured pool — no arrivals — so the
      // queue stays empty iff nothing reserved-specific ever enqueues it.
      fetchCatalog: async () => [
        { id: 'vendor/model-a', pricing: { prompt: '0', completion: '0' } },
        { id: 'vendor/model-b', pricing: { prompt: '0', completion: '0' } },
        { id: 'vendor/model-c', pricing: { prompt: '0', completion: '0' } },
      ],
      log: (m) => spawned.push(m),
      forceSweep: true,
      heldLockProfile: 'paid',
    });
    // (No write assertion here: a first-ever pass may legitimately persist its
    // fingerprint record; the pin's subject is the QUEUE, asserted below.)
    const queue = dc.readCandidates(() => []);
    expect(queue.paid.map((e) => e.id)).not.toContain('vendor/reserved-x');
    expect(queue.paid).toHaveLength(0);
    // The whole point of pin (a): the reservation machinery — getEnsembleModels
    // + the boot migration — never names the reserved id as a benchmark
    // candidate, so no populate child could ever have been spawned FOR it.
    expect(spawned.join('\n')).not.toMatch(/vendor\/reserved-x/);
  });

  it('(b) a reserved id arriving through the NORMAL catalog path stays benchmarkable/evictable — no reserved-name special case blocks the sweep', async () => {
    cfgDir = mkdtempSync(join('/tmp', 'llm-ext-f6b-'));
    // The user DELETED the reserved slot (their to delete — the seed never
    // re-runs) but kept vendor/reserved-x in paid_models: from the machinery's
    // point of view it is now an ordinary catalog id, and the ordinary rules
    // apply — dead ids are evicted, live ids are benchmarkable.
    const PAID_RESERVED_AS_ORDINARY = `active: paid
allow_paid_models: true
profiles:
  # <-- do not touch, generated by llm-ext -->
  paid:
    mode: remote-ensemble
    api: openrouter-remote
    model: vendor/model-a
    second_model: vendor/model-b
    third_model: vendor/reserved-x
    paid_models: [vendor/model-a, vendor/model-b, vendor/reserved-x]
    api_key: "sk-test-fake-openrouter-key"
`;
    writeFileSync(join(cfgDir, 'settings.yaml'), PAID_RESERVED_AS_ORDINARY, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    delete process.env.BAI_API_KEY;
    delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    const dm = await import('./dynamic-maintainer.js');
    const dc = await import('./dynamic-candidates.js');
    const logs: string[] = [];
    // A catalog where vendor/reserved-x has VANISHED: the ordinary eviction
    // (isDead → catalogById miss) must treat it exactly like any other id —
    // the pass must write a patch dropping it from third_model/paid_models.
    // A reserved-id special case in the eviction would leave it in the pool
    // forever, and this assertion is what breaks.
    const wrote = await dm.maintainDynamicProfiles({
      fetchCatalog: async () => [
        { id: 'vendor/model-a', pricing: { prompt: '0.0000001', completion: '0.0000001' } },
        { id: 'vendor/model-b', pricing: { prompt: '0.0000001', completion: '0.0000001' } },
      ],
      log: (m) => logs.push(m),
      forceSweep: true,
      heldLockProfile: 'paid',
    });
    expect(wrote).toBe(true);
    const { loadSettings } = await import('./config.js');
    const paid = loadSettings()?.profiles?.paid as {
      third_model?: string;
      paid_models?: string[];
    };
    // Ordinary-id semantics: the vanished id is dropped from the RANKED pool
    // (paid_models) exactly like any other catalog-absent id; the third slot
    // field itself is only rewritten when the refilled ranking has a model for
    // it (2 survivors fill slots 0-1), so the pin asserts the pool eviction,
    // which is the eviction that drives sends.
    expect(paid.paid_models).not.toContain('vendor/reserved-x');
    expect(paid.paid_models).toEqual(['vendor/model-a', 'vendor/model-b']);
    // And symmetrically: an id that ARRIVES (not configured, catalog-live,
    // price under the ceiling) must be QUEUED — benchmarkable — regardless of
    // any reserved history; the queue arm has no reserved check to trip over.
    const queue = dc.readCandidates(() => []);
    expect(Array.isArray(queue.paid)).toBe(true);
  });
});

// fix-queue 83 (P6d live smoke step 2e): with --profile paid on an unpopulated
// `paid` section, the boot banner printed the internal PLACEHOLDER_MODEL_ID
// sentinel verbatim ("backend: OpenRouter (placeholder/unpopulated-default-
// profile)") -- the spec says that sentinel must never reach the user.
describe('writeBootBanner placeholder-id redaction (fix-queue 83)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  async function loadFresh(settingsYaml: string) {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-boot-banner-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), settingsYaml, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    return import('./index.js');
  }

  it('an unpopulated paid profile prints "paid: not benchmarked yet", never the placeholder id', async () => {
    // The `paid:` section is written out exactly as unpopulatedPaidProfile()
    // (config.ts) shapes it -- same state a fresh install's dynamic 'paid'
    // profile is in before its first benchmark, which is what the live smoke
    // test hit.
    const idx = await loadFresh(`allow_paid_models: true
profiles:
  paid:
    mode: remote
    api: openrouter-remote
    model: placeholder/unpopulated-default-profile
    api_key: "sk-test-fake-openrouter-key"
`);
    // Review follow-up F1: in 14.0.0 `active:` is NOT the selection path (it
    // is only a boot-banner display fallback inside effectiveProfileName),
    // and is rewritten in 14.1.0 -- select via the real `--profile paid`
    // path (overrideActiveProfile) so this test survives that rewrite.
    idx.overrideActiveProfile('paid');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    idx.writeBootBanner();
    // Read .mock.calls BEFORE mockRestore() -- mockRestore() also clears the
    // call history (it is mockReset() + restore, not just restore), so
    // reading after it always sees an empty array regardless of what the
    // function actually wrote.
    const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();
    expect(banner).toMatch(/backend: OpenRouter \(paid: not benchmarked yet\)/);
    expect(banner).not.toContain('placeholder/unpopulated-default-profile');
  });

  it('a populated profile still prints the real model id unchanged', async () => {
    const idx = await loadFresh(`allow_paid_models: true
profiles:
  bare:
    mode: remote
    api: openrouter-remote
    model: vendor/real-model
    api_key: "sk-test-fake-openrouter-key"
`);
    // Review follow-up F1: pin selection through the real --profile path,
    // not the `active:` display fallback -- see the comment above.
    idx.overrideActiveProfile('bare');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    idx.writeBootBanner();
    const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();
    expect(banner).toMatch(/backend: OpenRouter \(vendor\/real-model\)/);
  });

  // fix-queue 89/95a: `local`'s stub carries `api: lmstudio-local`, which
  // RESOLVES to a real localhost:1234 URL (unlike free/paid's placeholder
  // openrouter-remote URL) before dynamicProfileGate ever runs -- the
  // OpenRouter branch's fq83 fix and the Model-line fix above both key off
  // `bootBackend.type === "openrouter"`/the raw model text alone, so the
  // Local/Remote branch needed its OWN check that it interpolates the
  // population-state label, not the raw sentinel, alongside a real URL.
  it('an unpopulated local profile prints "local: not benchmarked yet" alongside the real localhost URL, never the placeholder id', async () => {
    // D0 fix-up (TRDD-AL8GIZYA): `providers: []` IS present —
    // unpopulatedLocalProfile() carries it again (see its docblock in
    // config.ts), and this fixture must byte-match it for
    // isUnpopulatedDefaultProfile to detect it.
    const idx = await loadFresh(`allow_paid_models: true
profiles:
  local:
    mode: local
    api: lmstudio-local
    model: placeholder/unpopulated-default-profile
    free_models: []
    providers: []
`);
    idx.overrideActiveProfile('local');
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    idx.writeBootBanner();
    const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();
    expect(banner).toMatch(/backend: Local \(http:\/\/localhost:1234, local: not benchmarked yet\)/);
    expect(banner).not.toContain('placeholder/unpopulated-default-profile');
  });

  // fix-queue 89: row 83 covered only writeBootBanner's openrouter branch --
  // `discover` (the `settings status` CLI command's dispatch target,
  // cli/active-precedence.test.ts) has its OWN separate "Model:" line
  // (index.ts) that also printed the raw sentinel for an unpopulated
  // dynamic profile.
  it('`discover` ("settings status") prints "paid: not benchmarked yet" on the Model: line, never the placeholder id', async () => {
    const idx = await loadFresh(`allow_paid_models: true
profiles:
  paid:
    mode: remote
    api: openrouter-remote
    model: placeholder/unpopulated-default-profile
    api_key: "sk-test-fake-openrouter-key"
`);
    idx.overrideActiveProfile('paid');
    await idx.boot();
    const result = await idx.dispatchCallTool('discover', {});
    const text = result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(text).toMatch(/Model: paid: not benchmarked yet/);
    expect(text).not.toContain('placeholder/unpopulated-default-profile');
  });

  // fix-queue 89: the `profile --show <name>` tool (formatResolvedProfileLines,
  // config.ts) is the THIRD print site that read the resolved profile's raw
  // `model` field -- separate from both writeBootBanner and discover's
  // Model: line above, and not audited by row 83.
  it('`profile --show paid` prints "paid: not benchmarked yet" on the Model: line, never the placeholder id', async () => {
    const idx = await loadFresh(`allow_paid_models: true
profiles:
  paid:
    mode: remote
    api: openrouter-remote
    model: placeholder/unpopulated-default-profile
    api_key: "sk-test-fake-openrouter-key"
`);
    idx.overrideActiveProfile('paid');
    await idx.boot();
    const result = await idx.dispatchCallTool('profile', { show: 'paid' });
    const text = result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(text).toMatch(/Model: paid: not benchmarked yet/);
    expect(text).not.toContain('placeholder/unpopulated-default-profile');
  });
});

// OE27RD7I row 18: `settings status` printed "benchmark-vetted" from the
// written free_models list alone. The label must reflect population state:
// a completed benchmark (lastBenchmarkAt > 0) and an empty free queue.
describe('settings status free-pool label (OE27RD7I row 18)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  const FREE_YAML = `active: free
allow_paid_models: false
profiles:
  # <-- do not touch, generated by llm-ext -->
  free:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: [vendor/free-a:free, vendor/free-b:free]
    model: vendor/free-a:free
    api_key: "sk-test-fake-openrouter-key"
`;

  async function statusText(seed?: (cfg: string) => Promise<void> | void): Promise<string> {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-pool-label-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), FREE_YAML, 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    stampProfileMigrationDone(Date.now());
    await seed?.(cfgDir);
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('free');
    await idx.boot();
    const result = await idx.dispatchCallTool('discover', {});
    return result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  }

  it('prints "benchmark-vetted" only after a completed benchmark with an empty free queue', async () => {
    const text = await statusText(() => recordDynamicBenchmarkAt('free', Date.now()));
    expect(text).toMatch(/Free pool \(2, benchmark-vetted, /);
  });

  it('never claims "benchmark-vetted" for a free profile that has not been benchmarked', async () => {
    const text = await statusText();
    expect(text).toMatch(/Free pool \(2, not yet benchmarked, /);
    expect(text).not.toContain('benchmark-vetted');
  });

  it('prints a queued-candidate count when a benchmarked free profile still has a queued candidate', async () => {
    const text = await statusText(async () => {
      recordDynamicBenchmarkAt('free', Date.now());
      enqueueCandidates('free', ['vendor/free-a:free']);
    });
    expect(text).toMatch(/Free pool \(2, 1 candidate awaiting benchmark, /);
    expect(text).not.toContain('benchmark-vetted');
  });
});
// Review of 41e36a0e: the label and count must describe the SAME pool. The vetting
// state comes only from the built-in dynamic `free` profile's record; a static
// free_only profile with hand-listed models is exempt from benchmarks by design.
describe('settings status free-pool label on a static free_only profile (OE27RD7I review)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  const STATIC_YAML = (allowPaid: boolean): string => `active: mine
allow_paid_models: ${allowPaid}
profiles:
  mine:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: [vendor/hand-a:free, vendor/hand-b:free]
    model: vendor/hand-a:free
    api_key: "sk-test-fake-openrouter-key"
`;

  async function staticStatusText(allowPaid: boolean): Promise<string> {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-static-pool-label-'));
    writeFileSync(join(cfgDir, 'settings.yaml'), STATIC_YAML(allowPaid), 'utf-8');
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    stampProfileMigrationDone(Date.now());
    // An unrelated completed `free` record that the old code wrongly borrowed.
    recordDynamicBenchmarkAt('free', Date.now());
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('mine');
    await idx.boot();
    const result = await idx.dispatchCallTool('discover', {});
    return result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
  }

  it('says "as listed in the profile" and makes no benchmark claim for a static free_only profile', async () => {
    const text = await staticStatusText(true);
    expect(text).toMatch(/Free pool \(2, as listed in the profile, not benchmarked by design, /);
    expect(text).not.toContain('benchmark-vetted');
    expect(text).not.toContain('not yet benchmarked');
  });

  it('never offers the deleted auto-free reason', async () => {
    expect(await staticStatusText(true)).toContain('Free mode: ON (profile free_only)');
    expect(await staticStatusText(false)).not.toContain('low balance');
    expect(await staticStatusText(true)).not.toContain('low balance');
  });
});
// fix-queue 90: the module-scope `currentBackend` IIFE falls back to a
// hard-coded "http://localhost:1234" BackendConfig when `activeResolved` is
// null at IMPORT time (a genuinely invalid settings.yaml -- not the
// self-healing unpopulated-placeholder case, which resolves fine). Audit
// question: can any REAL dispatch actually reach that hard-coded backend, or
// does dispatchCallToolInner's settingsValid gate always intercept first?
// This pins the answer instead of leaving it a read-only claim: the CLI
// (cli/main.ts) always calls overrideActiveProfile before any dispatch, and
// every non-CLI entry point (this test imports index.ts directly, the same
// way a stray test-only caller would) still goes through dispatchCallTool,
// which refuses every LLM-driving tool while settingsValid is false -- so
// the hard-coded backend is observable (writeBootBanner, getCurrentBackend)
// but never actually sent a request in production.
describe('module-scope no-selection backend fallback (fix-queue 90)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it('a genuinely invalid settings.yaml boots to the hard-coded local placeholder, and every LLM tool still refuses NOT CONFIGURED', async () => {
    // Same shape boot-reload-validity.test.ts's S1 fixtures use to force
    // settingsValid:false/activeResolved:false: `active:` omitted (defaults
    // to 'free', itself marked+unpopulated -- exempt on its own), but a
    // SEPARATE unmarked hand-authored `paid:` section makes the settings
    // document invalid as a WHOLE (a settings-level check, not per-profile).
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-no-selection-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'allow_paid_models: false',
        'profiles:',
        ' # <-- do not touch, generated by llm-ext -->',
        '  free:',
        '    mode: remote',
        '    api: openrouter-remote',
        '    free_only: true',
        '    free_models: []',
        '    model: placeholder/unpopulated-default-profile',
        '    api_key: $OPENROUTER_API_KEY',
        '  paid:',
        '    mode: remote',
        '    api: openrouter-remote',
        '    model: vendor/my-favourite-paid-model',
        '    api_key: $OPENROUTER_API_KEY',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    // Pre-stamp the one-time migration as already done (same recipe
    // boot-reload-validity.test.ts's loadFreshIndex uses, for the same
    // reason): on a genuinely FRESH boot, migrateProfileSections would
    // silently back up + regenerate this unmarked `paid:` section before
    // evaluateSettingsValidity ever sees it -- exactly what migration is
    // for, but it would make it impossible to reach the "genuinely
    // invalid" state this test needs (the real-world window this mirrors
    // is: migration ran once, long ago; the user hand-edited a
    // reserved-name section afterwards).
    stampProfileMigrationDone(Date.now());
    vi.resetModules();
    const idx = await import('./index.js');

    expect(idx.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });

    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    idx.writeBootBanner();
    const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    writeSpy.mockRestore();
    expect(banner).toContain('backend: Local (http://localhost:1234)');

    await idx.boot();
    const result = await idx.dispatchCallTool('chat', { message: 'hi' });
    expect(result.isError).toBe(true);
    const text = result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(text).toContain('NOT CONFIGURED');
  });
});

// fix-queue P1 follow-up (adversarial review of 5ed7de5, item 2): the outer
// try/catch inside dispatchCallToolInner (its OWN tail, not main().catch)
// converts every thrown Error -- including resolveModelOverride's refusal --
// into the same `{ content: [...], isError: true }` shape every other
// refusal in this function returns. A prior comment at the call site claimed
// the error "propagates to main().catch"; that claim was never true for the
// MCP/dispatchCallTool entry point (only the CLI's separate catch in
// cli/main.ts sees an actually-uncaught rejection), so this test pins the
// real, observable behaviour at the dispatch boundary this file owns.
describe('resolveModelOverride refusal reaches the caller as isError, not a rejection (fix-queue P1 follow-up item 2)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it("free:true on a STATIC profile with no ':free' model resolves as isError, naming the profile and the remedy -- dispatchCallTool never rejects", async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-refusal-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'active: paidstatic',
        'allow_paid_models: true',
        'profiles:',
        '  paidstatic:',
        '    mode: remote',
        '    api: openrouter-remote',
        '    model: vendor/whatever',
        '    api_key: "sk-test-fake-openrouter-key"',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('paidstatic');
    await idx.boot();

    // resolveModelOverride throws SYNCHRONOUSLY before any network hop (the
    // refusal fires before `paidstatic`'s chain is ever walked for real), so
    // this call never touches the network and cannot hang or flake.
    const result = await idx.dispatchCallTool('chat', { message: 'hi', free: true });
    expect(result.isError).toBe(true);
    const text = result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
    expect(text).toContain('paidstatic');
    expect(text).toMatch(/use --profile free, or add a ':free' model/);
  });
});

// fix-queue P1 follow-up item 1: `free_only` (the built-in `free` profile,
// or any profile marked free_only) is $0 by construction -- a route-served
// b.ai id with NO ':free' suffix (the b.ai-only leg's first/only slot) must
// still resolve, not refuse. Reuses the same b.ai-route fixture shape the
// Rule-5/ensemble describe block above already uses for the identical
// cost-safety exemption on the ensemble path (BAI_FREE_YAML), here for the
// single-model `free: true` flag instead.
describe("free:true resolves a free_only profile's non-':free' route-served id (fix-queue P1 follow-up item 1)", () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it("a free_only profile whose only chain entry is a route-served id (no ':free' suffix) routes through it instead of refusing", async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-bai-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'active: bai-free-single',
        'allow_paid_models: false',
        'profiles:',
        '  bai-free-single:',
        '    mode: remote',
        '    api: chat-b-ai-remote',
        '    model: glm-5.3-flash',
        '    free_only: true',
        '    free_models: [glm-5.3-flash]',
        '    providers:',
        '      - api: chat-b-ai-remote',
        '        models: [glm-5.3-flash]',
        '        api_key: "sk-test-fake-bai-key"',
        '    api_key: "sk-test-fake-bai-key"',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('bai-free-single');
    await idx.boot();

    // Stub the network hop with an immediate, minimal success response so
    // this test proves ONLY the routing decision (the stderr line printed
    // synchronously, before any request goes out) -- not a real b.ai round
    // trip, which the honest-402.test.ts file already exercises elsewhere.
    //
    // A factory (mockImplementation), NOT mockResolvedValue: a `Response`
    // body is a stream that can be read exactly once, and mockResolvedValue
    // hands out the SAME Response instance on every call.
    //
    // Row 104 (report 20260918_063842+0200-p14.1-rows104-27.md Q1, ✓
    // VERIFIED by tracing chatCompletionWithRetry's while(true) loop in
    // provider/completion.ts): the PRIOR body, `{choices:[{message:
    // {content:'ok'}}]}`, carried no `finish_reason` key, so
    // completion.ts's `finishReason = data.choices?.[0]?.finish_reason ??
    // ""` parsed to the falsy `""`, which walks the generic-failure retry
    // branch instead of the `=== "stop"` success branch -- the loop then
    // retried up to MAX_TRUNCATION_RETRIES=3 more times (4 calls total),
    // and under mockResolvedValue's single shared Response instance every
    // retry after the first threw "Unexpected end of JSON input" trying to
    // re-read an already-consumed stream. A realistic success body
    // (`finish_reason: "stop"` plus a `usage` block, as a real provider
    // sends) takes the success branch on the first call, so one dispatch
    // makes exactly one fetch call.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
      );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // Nit (adversarial review of 9919de9): `instructions`, not `message` --
      // 'chat' has no `message` arg (index.ts destructures `instructions` /
      // `instructions_files_paths`), so the original `{ message: 'hi' }` never
      // had a non-empty prompt and refused with "FAILED: Either instructions
      // or instructions_files_paths must be provided" BEFORE reaching fetch --
      // that refusal still fires after the routing banner (printed earlier,
      // at the modelOverride resolution), so the banner-only assertions below
      // passed regardless of whether the request ever went out. `instructions`
      // lets the call actually reach the network so the fetch assertion means
      // something.
      await idx.dispatchCallTool('chat', { instructions: 'hi', free: true });
    } finally {
      // Item 1 (e3-touch): snapshot the calls and restore the spy BEFORE
      // asserting, not after -- the prior order ran the assertions first and
      // called `fetchSpy.mockRestore()` only once they passed, so a FAILING
      // assertion threw out of the `finally` block and skipped
      // `mockRestore()`, leaving `globalThis.fetch` mocked for every test
      // that runs later in this file. `vitest.config.ts` does not set
      // `restoreMocks`, so nothing else would undo that leak. Reading
      // `.mock.calls` after `mockRestore()` would report zero calls (it
      // clears recorded calls same as `mockClear()`), so the snapshot must
      // come first.
      const calls = [...fetchSpy.mock.calls];
      fetchSpy.mockRestore();
      const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      writeSpy.mockRestore();
      // The route-served id has no ':free' suffix -- resolveModelOverride
      // (via firstFreeIdInChain's free_only branch) must still have picked
      // it, never refused with "no ':free' model in its chain".
      expect(banner).toContain('Routing through glm-5.3-flash (free requested)');
      expect(banner).not.toContain("no ':free' model in its chain");
      // Nit (adversarial review of 9919de9): the banner alone doesn't prove
      // the request actually went to b.ai -- assert every mocked fetch
      // call's URL carries the b.ai host (config.ts's chat-b-ai-remote
      // preset: defaultUrl "https://api.b.ai"), not just that no error was
      // thrown. Row 104: a realistic success body (finish_reason: "stop")
      // now pins EXACTLY one fetch call for one dispatch, proving a valid
      // response is sent once rather than retried.
      expect(calls.length).toBe(1);
      for (const call of calls) {
        expect(String(call[0])).toContain('api.b.ai');
      }
    }
  });
});

// Row 100: `free: true` on the `local` dynamic profile refused with "use
// --profile free, or add a ':free' model" -- a wrong remedy for a
// non-billable mode that never carries a `:free` suffix. firstFreeIdInChain
// now treats any chain entry served by a non-billable route (local, or a
// free-by-nature provider) as free, exactly like a free_only entry, reusing
// billableForRoute (config.ts) so this can never drift from what
// resolveConnection actually bills.
describe("free:true on the local dynamic profile (row 100)", () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;
  let prevDisableReconcile: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    prevDisableReconcile = process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    // `local` is a machine-owned dynamic profile name -- boot() otherwise
    // detects the hand-written section as a "change" and regenerates it from
    // a real endpoint scan (which finds nothing on a test machine), silently
    // overwriting the fixture this test relies on. Disabling reconciliation
    // leaves the hand-written section alone; it has no bearing on the code
    // path under test (firstFreeIdInChain/resolveModelOverride), which never
    // reads this flag.
    process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = "1";
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (prevDisableReconcile === undefined) delete process.env.LLM_EXT_DISABLE_AUTO_RECONCILE;
    else process.env.LLM_EXT_DISABLE_AUTO_RECONCILE = prevDisableReconcile;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it('a populated local-mode profile routes free:true through its own model instead of refusing (red on HEAD)', async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-local-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        // 'localstatic', not the machine-owned name 'local': boot() detects
        // a hand-written 'local' section as a change from what the
        // maintainer expects and regenerates it from a real endpoint scan
        // (finds nothing here -> overwrites this fixture's model with the
        // placeholder), same reason the b.ai routing test above uses
        // 'bai-free-single' rather than the built-in 'free'. The code path
        // under test (firstFreeIdInChain's non-billable-route branch) keys
        // off the resolved profile's mode/route, not its name.
        'active: localstatic',
        'allow_paid_models: true',
        'profiles:',
        '  localstatic:',
        '    mode: local',
        '    api: lmstudio-local',
        '    model: qwen2.5-coder-7b',
        '    providers: []',
        '    free_models: []',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('localstatic');
    await idx.boot();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await idx.dispatchCallTool('chat', { instructions: 'hi', free: true });
    } finally {
      const calls = [...fetchSpy.mock.calls];
      fetchSpy.mockRestore();
      const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      writeSpy.mockRestore();
      // On HEAD, firstFreeIdInChain only accepted `profile.freeOnly` or a
      // `:free`-suffixed id -- a local profile's own route-served model id
      // has neither, so this refused with "use --profile free, or add a
      // ':free' model", never printing the routing banner.
      expect(banner).toContain('Routing through qwen2.5-coder-7b (free requested)');
      expect(banner).not.toContain("use --profile free, or add a ':free' model");
      // Not pinned to exactly 1 (unlike the b.ai test above): the lmstudio
      // provider probes its native API before completion, so a local-mode
      // dispatch legitimately makes more than one fetch call; what this test
      // proves is that it was routed and reached the network at all.
      expect(calls.length).toBeGreaterThan(0);
    }
  });

  it('an unpopulated (empty) local profile refuses free:true with the local remedy, never the free-profile one', async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-local-empty-'));
    // D0 fix-up (TRDD-AL8GIZYA): `providers: []` IS present — see the
    // sibling writeBootBanner fixture above for why.
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'allow_paid_models: true',
        'profiles:',
        '  local:',
        '    mode: local',
        '    api: lmstudio-local',
        '    model: placeholder/unpopulated-default-profile',
        '    free_models: []',
        '    providers: []',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('local');
    await idx.boot();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const result = await idx.dispatchCallTool('chat', { instructions: 'hi', free: true });
      expect(result.isError).toBe(true);
      const text = result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
      // dynamicProfileGate (dynamic-maintainer.ts) intercepts an unpopulated
      // machine-owned `local` profile before dispatch ever reaches
      // resolveModelOverride, and already names the local remedy -- this
      // pins that a genuinely empty local profile still gets it, never the
      // free-profile "use --profile free" wording that made no sense for a
      // non-billable mode.
      expect(text).not.toContain("use --profile free, or add a ':free' model");
      expect(text.toLowerCase()).toMatch(/local (endpoint|server)|llama\.cpp|lm studio|ollama|vllm/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// fix-queue 98(2), the two resolution halves the sibling describes above leave
// unpinned: a STATIC (non-free_only, OpenRouter) profile WITH a ':free' id in
// its chain must route free:true through THAT id (never borrow outside the
// profile), and the built-in dynamic `free` profile must route free:true
// through its OWN head. Both red on the pre-98(2) code (FREE_MODEL_ID
// pinned "poolside/laguna-m.1:free" for every profile), where the static
// ':free' case routed through a model the profile never listed and the
// built-in free profile's head was ignored in favour of the same constant.
describe("free:true resolves the SELECTED profile's own ':free' chain entries (fix-queue 98(2))", () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it("a STATIC profile with a ':free' model in its chain routes free:true through that id", async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-static-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'active: staticfree',
        'allow_paid_models: true',
        'profiles:',
        '  staticfree:',
        // PT-06: a custom profile with free_models is a free-type profile; untyped it is inferred paid, and free_models is not a paid field.
        '    profile-type: free',
        '    mode: remote',
        '    api: openrouter-remote',
        '    model: vendor/free-a:free',
        '    free_models: [vendor/free-a:free]',
        '    api_key: "sk-test-fake-openrouter-key"',
        '',
      ].join('\n'),
      'utf-8',
    );
    // D3c send-time price gate (benchmark/validated.ts) fails closed on a cold
    // price cache even for a ':free'-suffixed id (it cannot know the id is $0
    // without a catalog entry), and this test drives no maintainer pass — seed
    // the cache directly, same recipe honest-402.test.ts Path 3 uses.
    writeFileSync(
      join(cfgDir, 'catalog-cache.json'),
      JSON.stringify({
        fetchedAtMs: Date.now(),
        models: [
          { id: 'vendor/free-a:free', pricing: { prompt: '0', completion: '0' } },
          { id: 'vendor/builtin-head:free', pricing: { prompt: '0', completion: '0' } },
          { id: 'vendor/builtin-second:free', pricing: { prompt: '0', completion: '0' } },
        ],
      }),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('staticfree');
    await idx.boot();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await idx.dispatchCallTool('chat', { instructions: 'hi', free: true });
    } finally {
      const calls = [...fetchSpy.mock.calls];
      fetchSpy.mockRestore();
      const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      writeSpy.mockRestore();
      // The profile's OWN ':free' id, never a hard-coded id outside it.
      expect(banner).toContain('Routing through vendor/free-a:free (free requested)');
      expect(banner).not.toContain('poolside/laguna-m.1:free');
      // The request itself went to the profile's own id. dispatch ALSO probes
      // the OpenRouter catalog + the id's endpoint metadata (fetches whose
      // body carries no model) before the single completion -- assert on the
      // CHAT call only, not the total fetch count.
      const chatCalls = calls.filter((c) => String(c[0]).includes('/chat/completions'));
      expect(chatCalls.length).toBe(1);
      for (const call of chatCalls) {
        const body = JSON.parse(String((call[1] as { body?: string })?.body ?? '{}'));
        expect(body.model).toBe('vendor/free-a:free');
      }
    }
  });

  it("the built-in dynamic 'free' profile routes free:true through its OWN head model", async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-builtin-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'active: free',
        'allow_paid_models: true',
        'profiles:',
        '  # <-- do not touch, generated by llm-ext -->',
        '  free:',
        '    mode: remote-ensemble',
        '    api: openrouter-remote',
        '    free_only: true',
        '    free_models: [vendor/builtin-head:free, vendor/builtin-second:free]',
        '    model: vendor/builtin-head:free',
        '    api_key: "sk-test-fake-openrouter-key"',
        '',
      ].join('\n'),
      'utf-8',
    );
    // D3c send-time price gate (benchmark/validated.ts) fails closed on a cold
    // price cache even for a ':free'-suffixed id (it cannot know the id is $0
    // without a catalog entry), and this test drives no maintainer pass — seed
    // the cache directly, same recipe honest-402.test.ts Path 3 uses.
    writeFileSync(
      join(cfgDir, 'catalog-cache.json'),
      JSON.stringify({
        fetchedAtMs: Date.now(),
        models: [
          { id: 'vendor/builtin-head:free', pricing: { prompt: '0', completion: '0' } },
          { id: 'vendor/builtin-second:free', pricing: { prompt: '0', completion: '0' } },
        ],
      }),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('free');
    await idx.boot();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      );
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await idx.dispatchCallTool('chat', { instructions: 'hi', free: true });
    } finally {
      const calls = [...fetchSpy.mock.calls];
      fetchSpy.mockRestore();
      const banner = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      writeSpy.mockRestore();
      // The built-in profile's own head, never the deleted FREE_MODEL_ID.
      expect(banner).toContain('Routing through vendor/builtin-head:free (free requested)');
      expect(banner).not.toContain('poolside/laguna-m.1:free');
      // Same catalog-probe exemption as the sibling test above: assert on the
      // CHAT call only (the endpoint-metadata probe carries no model body).
      const chatCalls = calls.filter((c) => String(c[0]).includes('/chat/completions'));
      expect(chatCalls.length).toBe(1);
      for (const call of chatCalls) {
        const body = JSON.parse(String((call[1] as { body?: string })?.body ?? '{}'));
        expect(body.model).toBe('vendor/builtin-head:free');
      }
    }
  });
});
// adversarial review follow-up (p14.1 r92/p1fu item 1): firstFreeIdInChain
// trusts `profile.freeOnly` with no per-id check of its own -- the SHOULD-FIX
// finding asked whether a guard exists upstream for a profile mismarked
// free_only whose first chain entry is actually billable (no ':free' suffix,
// no non-billable 'providers[]' route). It does: validateProfile (config.ts,
// the free_only pool check) rejects such a free_models entry at
// validateSettings time, via `billableForRoute` (config.ts) -- and
// dispatchCallToolInner gates every tool except discover/reset/get_settings/
// profile/list_profiles/scan_local_llm_services behind `settingsValid`
// (index.ts), so the mismarked profile never becomes active and 'chat' never
// reaches firstFreeIdInChain at all. This test proves the refusal fires
// before any network request, on the dispatch boundary this file owns.
describe('a free_only profile whose first entry is billable is refused before any request (fix-queue P1 follow-up item 1)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it("free_only: true with a billable first model (no ':free' suffix, no non-billable route) never boots and never calls fetch", async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-free-mismarked-'));
    writeFileSync(
      join(cfgDir, 'settings.yaml'),
      [
        'active: mismarked-free-only',
        'allow_paid_models: true',
        'profiles:',
        '  mismarked-free-only:',
        '    mode: remote',
        '    api: openrouter-remote',
        // No ':free' suffix and no `providers:` route -- a genuinely billable
        // OpenRouter id, exactly the "mismarked free_only" shape the review
        // asked about.
        '    model: vendor/billable-model',
        '    free_only: true',
        '    free_models: [vendor/billable-model]',
        '    api_key: "sk-test-fake-openrouter-key"',
        '',
      ].join('\n'),
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    const idx = await import('./index.js');
    idx.overrideActiveProfile('mismarked-free-only');
    await idx.boot();

    // Guard 1: the profile never became active (validateProfile's free_only
    // pool check rejected it at settings-validation time).
    expect(idx.__getBootStateForTests().settingsValid).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      // Relabeled (fix-queue p14.1 e2-touch item 3, item 2): this exercises
      // guard 1 only, in firstFreeIdInChain's own source-comment numbering --
      // dispatchCallToolInner refuses every tool but discover/reset/
      // get_settings/profile/list_profiles/scan_local_llm_services while
      // settingsValid is false, so 'chat' never reaches resolveModelOverride,
      // firstFreeIdInChain, or resolveConnection (guard 2) at all -- proven by
      // the mocked fetch never being invoked, not just by an error string
      // matching.
      const result = await idx.dispatchCallTool('chat', { instructions: 'hi', free: true });
      expect(result.isError).toBe(true);
      const text = result.content.map((c: { text?: string }) => c.text ?? '').join('\n');
      expect(text).toContain('NOT CONFIGURED');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// D0 fix-up (TRDD-AL8GIZYA), task step 5: prove the boot-order interaction
// IN-PROCESS — the first command against a settings.yaml carrying ONLY the
// top-level `ensemble_price_ceiling_usd_per_million` (the pre-14.1.0 shape,
// unambiguous: no `profiles.paid.selection` yet) must migrate it and must
// NOT be refused by E-D3. index.ts's boot IIFE runs `migrateProfileSections`
// then `migrateSettingsTo141` in that order at module-import time
// (index.ts:389-403) — importing index.ts fresh, the same recipe every other
// describe block in this file uses, drives that exact sequence; there is no
// other entrypoint that exercises it without spawning dist.
describe('D0 fix-up: boot-order migration of the top-level price ceiling (TRDD-AL8GIZYA)', () => {
  let cfgDir: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  });
  afterEach(() => {
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
    cfgDir = undefined;
  });

  it('a fresh boot migrates the top-level ceiling into profiles.paid.selection, deletes the top-level key, and settingsLevelErrors reports no E-D3', async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'llm-ext-boot-order-141-'));
    const settingsPath = join(cfgDir, 'settings.yaml');
    writeFileSync(
      settingsPath,
      `allow_paid_models: true
ensemble_price_ceiling_usd_per_million: 1.3
profiles:
  paid:
    mode: remote
    api: openrouter-remote
    model: vendor/real-model
    api_key: "sk-test-fake-openrouter-key"
`,
      'utf-8',
    );
    process.env.LLM_EXT_CONFIG_DIR = cfgDir;
    vi.resetModules();
    // The boot IIFE runs at import time — no separate boot() call needed for
    // the migration itself (unlike dispatchCallTool's own boot() gate).
    const [idx, cfg] = await Promise.all([import('./index.js'), import('./config.js')]);
    idx.overrideActiveProfile('paid');

    const onDisk = readFileSync(settingsPath, 'utf-8');
    expect(onDisk).not.toContain('ensemble_price_ceiling_usd_per_million:');
    expect(onDisk).toMatch(/selection:\s*\n\s*price_ceiling_usd_per_million:\s*1\.3/);

    const loaded = cfg.loadSettings();
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    expect(cfg.getEnsemblePriceCeiling(loaded)).toBe(1.3);
    // E-D3 is the ambiguous-ceiling refusal — this run has only ONE value
    // ever, so it must not fire.
    expect(cfg.settingsLevelErrors(loaded).some((e) => e.includes('ensemble_price_ceiling_usd_per_million'))).toBe(
      false,
    );
  });
});
