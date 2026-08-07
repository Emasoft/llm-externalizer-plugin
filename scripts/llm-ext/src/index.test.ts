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
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveTestConfig, runCli, type CliResult } from './test-helpers';
import { buildTools } from './tools/definitions.js';
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
      'chat',
      'check_against_specs',
      'check_imports',
      'check_references',
      'code_task',
      'compare_files',
      'discover',
      'get_settings',
      'profile',
      // session_summary — compaction-style summary of a whole Claude Code
      // session from its JSONL transcript (TRDD-T4MZ8YQR), map-reduce +
      // checkpointed, $0-only free models.
      'session_summary',
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

  it('discover tool with no arguments is callable end-to-end', async () => {
    /**
     * Verifies the CLI wiring end to end: command resolution, flag parsing
     * (none needed here), boot(), and dispatchCallTool() all connect. discover
     * is chosen because it makes no LLM call (won't burn credits).
     */
    const result = await runCli(testConfig, 'discover');
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.type).toBe('text');
    expect(firstText(result)).toMatch(/Active profile:/);
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
     *  downgrade, when the backend cannot run it. The cost-safe test backend is
     *  LOCAL, so the paid-model gate refuses before any file is scanned. */
    const result = await runCli(testConfig, 'high_quality_scan', {
      folder_path: '/tmp',
      instructions: 'find bugs',
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/OpenRouter backend/i);
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

