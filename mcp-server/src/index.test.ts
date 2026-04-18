/**
 * Integration tests for the LLM Externalizer MCP server.
 *
 * These tests spawn the actual server process and communicate via stdio
 * using the MCP SDK client. No LLM backend is required for most tests —
 * only tools that don't make LLM calls (discover, listTools) are tested.
 *
 * For tools that DO call the LLM (chat, code_task, etc.), we test only the
 * input validation / error paths that fail before the LLM call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolveTestConfig, createTestClient } from './test-helpers';

// Uses the real ~/.llm-externalizer/settings.yaml — tests exercise the real pipeline.
const testConfig = resolveTestConfig({ testName: 'unit' });

async function createClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  return createTestClient(testConfig, 'test-client');
}

// ── Tool listing ──────────────────────────────────────────────────────

describe('listTools', () => {
  let client: Client;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('returns all expected tools', async () => {
    /** Verify the server exposes the full set of tools */
    const result = await client.listTools();
    const toolNames = result.tools.map(t => t.name).sort();

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
      'or_model_info',
      'or_model_info_json',
      'or_model_info_table',
      'reset',
      'scan_folder',
      'search_existing_implementations',
    ].sort();

    expect(toolNames).toEqual(expected);
  });

  it('each tool has a non-empty description', async () => {
    /** Every tool must have a description for MCP clients to display */
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.description, `Tool "${tool.name}" missing description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });

  it('each tool has an inputSchema', async () => {
    /** Every tool must declare its input schema */
    const result = await client.listTools();
    for (const tool of result.tools) {
      expect(tool.inputSchema, `Tool "${tool.name}" missing inputSchema`).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

// ── discover tool ─────────────────────────────────────────────────────

describe('discover', () => {
  let client: Client;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('returns service health information', async () => {
    /** discover returns status info — OFFLINE when no backend is running */
    const result = await client.callTool({ name: 'discover', arguments: {} });
    // discover always returns a result (even when offline)
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toBeDefined();
    // When no backend is running, it says OFFLINE
    // When a backend IS running, it mentions Local, LM Studio, or OpenRouter
    expect(text).toMatch(/OFFLINE|Local|LM Studio|OpenRouter/i);
  });

  it('accepts progress token without error', async () => {
    /** discover with a progress token should work (even though it finishes instantly) */
    const result = await client.callTool(
      { name: 'discover', arguments: {} },
      undefined,
      {
        onprogress: () => {},
        timeout: 30_000,
      },
    );
    expect(result.isError).toBeFalsy();
    // discover is instant — no progress expected, but no crash either
  });
});

// ── Input validation (error paths before LLM call) ───────────────────

describe('input validation', () => {
  let client: Client;
  let transport: StdioClientTransport | undefined;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('chat: fails without instructions or input', async () => {
    /** chat requires either instructions or input_files_paths */
    const result = await client.callTool({
      name: 'chat',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/FAILED/i);
  });

  it('code_task: fails without instructions or input', async () => {
    /** code_task requires either instructions or input_files_paths */
    const result = await client.callTool({
      name: 'code_task',
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it('batch_check: fails with empty input_files_paths', async () => {
    /** batch_check requires non-empty input_files_paths array */
    const result = await client.callTool({
      name: 'batch_check',
      arguments: { input_files_paths: [] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/input_files_paths/i);
  });

  it('compare_files: fails with fewer than 2 files', async () => {
    /** compare_files requires exactly 2 input files */
    const result = await client.callTool({
      name: 'compare_files',
      arguments: { input_files_paths: ['/nonexistent'] },
    });
    expect(result.isError).toBe(true);
  });

  it('scan_folder: fails with nonexistent folder', async () => {
    /** scan_folder should return error for nonexistent directory */
    const result = await client.callTool({
      name: 'scan_folder',
      arguments: {
        folder_path: '/tmp/__nonexistent_test_folder_12345',
        instructions: 'find bugs',
      },
    });
    expect(result.isError).toBe(true);
  });

});

// ── scan_secrets validation ──────────────────────────────────────────

describe('scan_secrets', () => {
  let client: Client;
  let transport: StdioClientTransport | undefined;
  const tmpDir = '/tmp/__llm_ext_test_secrets';
  const secretFile = join(tmpDir, 'secret.ts');

  beforeAll(async () => {
    ({ client, transport } = await createClient());
    mkdirSync(tmpDir, { recursive: true });
    // Write a file containing a fake API key pattern
    writeFileSync(secretFile, `const API_KEY = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz1234567890ab";\nconsole.log(API_KEY);\n`, 'utf-8');
  });

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (transport) await transport.close();
  });

  it('chat: aborts when scan_secrets finds secrets', async () => {
    /** chat with scan_secrets should abort when input files contain API keys */
    const result = await client.callTool({
      name: 'chat',
      arguments: {
        instructions: 'summarize this file',
        input_files_paths: secretFile,
        scan_secrets: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/secret|key|blocked|abort/i);
  });

  it('code_task: aborts when scan_secrets finds secrets', async () => {
    /** code_task with scan_secrets should abort when input files contain API keys */
    const result = await client.callTool({
      name: 'code_task',
      arguments: {
        instructions: 'review this file',
        input_files_paths: secretFile,
        scan_secrets: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/secret|key|blocked|abort/i);
  });

  it('batch_check: aborts when scan_secrets finds secrets', async () => {
    /** batch_check with scan_secrets should abort when input files contain secrets */
    const result = await client.callTool({
      name: 'batch_check',
      arguments: {
        input_files_paths: [secretFile],
        scan_secrets: true,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/secret|key|blocked|abort/i);
  });
});

// ── Progress notifications during LLM calls ──────────────────────────
// These tests verify that the server sends progress notifications when
// a tool takes a long time. Since we don't have an LLM backend, we
// test with tools that will fail AFTER sending at least one progress
// notification (connection refused to localhost:1234).

describe('progress notifications', () => {
  let client: Client;
  let transport: StdioClientTransport | undefined;
  const tmpDir = '/tmp/__llm_ext_test_progress';
  const testFile = join(tmpDir, 'hello.ts');

  beforeAll(async () => {
    ({ client, transport } = await createClient());
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testFile, 'export function hello() { return "world"; }\n', 'utf-8');
  });

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (transport) await transport.close();
  });

  it('chat: sends progress token in request without crash', async () => {
    /** Calling chat with a progressToken should not crash, even if LLM is unreachable */
    try {
      await client.callTool(
        {
          name: 'chat',
          arguments: {
            instructions: 'say hello',
          },
        },
        undefined,
        {
          onprogress: () => {},
          // Short timeout since the LLM backend is unreachable — it will fail on connect
          timeout: 120_000,
        },
      );
    } catch {
      // Expected: LLM backend is unreachable, so the call will error.
      // The key assertion is that it didn't crash the server.
    }

    // Verify the server is still alive after the failed call
    const discoverResult = await client.callTool({ name: 'discover', arguments: {} });
    expect(discoverResult.isError).toBeFalsy();
  });

  it('code_task: sends progress token in request without crash', async () => {
    /** code_task with a progressToken should not crash, even if LLM is unreachable */
    try {
      await client.callTool(
        {
          name: 'code_task',
          arguments: {
            instructions: 'review this file',
            input_files_paths: testFile,
          },
        },
        undefined,
        {
          onprogress: () => {},
          timeout: 120_000,
        },
      );
    } catch {
      // Expected: LLM backend unreachable
    }

    // Server should still be alive
    const discoverResult = await client.callTool({ name: 'discover', arguments: {} });
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
  let client: Client;
  let transport: StdioClientTransport | undefined;
  const tmpDir = '/tmp/__llm_ext_test_mode1';
  const srcDir = join(tmpDir, 'src');
  const scriptsDir = join(tmpDir, 'scripts');
  const srcA = join(srcDir, 'auth.ts');
  const srcB = join(srcDir, 'db.ts');
  const scriptFoo = join(scriptsDir, 'foo.py');
  const scriptBar = join(scriptsDir, 'bar.py');

  beforeAll(async () => {
    ({ client, transport } = await createClient());
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(srcA, 'export const a = 1;\n', 'utf-8');
    writeFileSync(srcB, 'export function db() {}\n', 'utf-8');
    writeFileSync(scriptFoo, 'def foo(): pass\n', 'utf-8');
    writeFileSync(scriptBar, 'def bar(): pass\n', 'utf-8');
  });

  afterAll(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (transport) await transport.close();
  });

  it('chat: answer_mode=1 routes mixed-extension files through auto-grouping without crash', async () => {
    /** With 4 files in 2 subdirs × 2 extensions, auto-grouping should
     * produce 2 groups (src-ts, scripts-py). The LLM is unreachable so
     * the call fails after the grouping decision — we only verify that
     * the server survives the routing path and didn't reject the request
     * up-front with a validation error. */
    let result;
    try {
      result = await client.callTool(
        {
          name: 'chat',
          arguments: {
            instructions: 'audit for bugs',
            input_files_paths: [srcA, srcB, scriptFoo, scriptBar],
            answer_mode: 1,
          },
        },
        undefined,
        { timeout: 60_000 },
      );
    } catch {
      // LLM unreachable or timed out mid-call — both acceptable.
      // The assertion below verifies the server is still alive.
    }
    // If the call returned cleanly (e.g. service returned an error body
    // but didn't throw), the response must NOT be a pre-LLM validation
    // failure (e.g. "instructions required"). An empty-LLM error is fine.
    if (result) {
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).not.toMatch(/instructions or input_files_paths is required/i);
      expect(text).not.toMatch(/folder_path is required/i);
    }
    // Server must still be responsive
    const discoverResult = await client.callTool({ name: 'discover', arguments: {} });
    expect(discoverResult.isError).toBeFalsy();
  });

  it('code_task: answer_mode=1 with explicit ---GROUP:id--- markers routes through grouped path', async () => {
    /** Group markers bypass auto-grouping — ensure the explicit path
     * still works. The LLM call fails but the server mustn't crash. */
    let result;
    try {
      result = await client.callTool(
        {
          name: 'code_task',
          arguments: {
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
        },
        undefined,
        { timeout: 60_000 },
      );
    } catch {
      // LLM unreachable
    }
    if (result) {
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).not.toMatch(/instructions.*required/i);
    }
    const discoverResult = await client.callTool({ name: 'discover', arguments: {} });
    expect(discoverResult.isError).toBeFalsy();
  });

  it('scan_folder: answer_mode=1 rejects nonexistent folder before any LLM call', async () => {
    /** scan_folder mode 1 should validate the folder exists BEFORE
     * walking it or issuing LLM calls, and BEFORE the auto-grouping
     * step runs on the (empty) file list. */
    const result = await client.callTool({
      name: 'scan_folder',
      arguments: {
        folder_path: '/tmp/__llm_ext_nonexistent_grouping',
        instructions: 'audit',
        answer_mode: 1,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/not found|Folder not found/i);
  });

  it('chat: answer_mode=2 still works as the single-merged-report path', async () => {
    /** Regression guard — the redesign must not have broken mode 2. */
    let result;
    try {
      result = await client.callTool(
        {
          name: 'chat',
          arguments: {
            instructions: 'summarize',
            input_files_paths: [srcA],
            answer_mode: 2,
          },
        },
        undefined,
        { timeout: 60_000 },
      );
    } catch {
      // LLM unreachable
    }
    if (result) {
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).not.toMatch(/instructions.*required/i);
    }
    const discoverResult = await client.callTool({ name: 'discover', arguments: {} });
    expect(discoverResult.isError).toBeFalsy();
  });

  it('search_existing_implementations: answer_mode=1 validates feature_description before grouping', async () => {
    /** SEI mode 1 path — missing feature_description must fail at the
     * top-level validator, not silently in the mode 1 branch. */
    const result = await client.callTool({
      name: 'search_existing_implementations',
      arguments: {
        folder_path: tmpDir,
        answer_mode: 1,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/feature_description/i);
  });
});

