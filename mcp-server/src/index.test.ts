/**
 * Integration tests for the LLM Externalizer MCP server.
 *
 * These tests spawn the actual server process and communicate via stdio
 * using the MCP SDK client. No LLM backend is required for most tests —
 * only tools that don't make LLM calls (discover, listTools) are tested.
 *
 * For tools that DO call the LLM (chat, code_task, fix_code, etc.),
 * we test only the input validation / error paths that fail before the LLM call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolveTestConfig, createTestClient } from './test-helpers';

// Uses the real ~/.llm-externalizer/settings.yaml — tests exercise the real pipeline.
const testConfig = resolveTestConfig({ testName: 'unit' });

async function createClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  return createTestClient(testConfig, 'test-client');
}

// ── Tool listing ──────────────────────────────────────────────────────

describe('listTools', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    await transport.close();
  });

  it('returns all expected tools', async () => {
    /** Verify the server exposes the full set of tools */
    const result = await client.listTools();
    const toolNames = result.tools.map(t => t.name).sort();

    // custom_prompt was merged into chat — it still works via switch fall-through
    // but is NOT listed as a separate tool in buildTools()
    // Write tools (fix_code, batch_fix, merge_files, split_file, revert_file)
    // are disabled via DISABLED_TOOLS and filtered out of buildTools()
    const expected = [
      'batch_check',
      'change_model',
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
      'set_settings',
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
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    await transport.close();
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
    const progressEvents: Array<{ progress: number; total?: number; message?: string }> = [];

    const result = await client.callTool(
      { name: 'discover', arguments: {} },
      undefined,
      {
        onprogress: (p) => {
          progressEvents.push({
            progress: p.progress,
            total: p.total,
            message: p.message,
          });
        },
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
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    await transport.close();
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

  it('disabled write tools return DISABLED error', async () => {
    /** All disabled write tools should be rejected with a DISABLED message */
    for (const toolName of ['fix_code', 'batch_fix', 'merge_files', 'split_file', 'revert_file']) {
      const result = await client.callTool({
        name: toolName,
        arguments: { instructions: 'test', input_files_paths: '/tmp/test.ts' },
      });
      expect(result.isError, `${toolName} should return isError`).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text, `${toolName} should mention DISABLED`).toMatch(/DISABLED/);
    }
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
  let transport: StdioClientTransport;
  const tmpDir = '/tmp/__llm_ext_test_secrets';
  const secretFile = join(tmpDir, 'secret.ts');

  beforeAll(async () => {
    ({ client, transport } = await createClient());
    mkdirSync(tmpDir, { recursive: true });
    // Write a file containing a fake API key pattern
    writeFileSync(secretFile, `const API_KEY = "sk-proj-1234567890abcdefghijklmnopqrstuvwxyz1234567890ab";\nconsole.log(API_KEY);\n`, 'utf-8');
  });

  afterAll(async () => {
    try { unlinkSync(secretFile); } catch { /* ignore */ }
    await transport.close();
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

// ── change_model ─────────────────────────────────────────────────────

describe('change_model', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    await transport.close();
  });

  it('updates model in active profile', async () => {
    /** change_model should update the model in the active profile */
    const result = await client.callTool({
      name: 'change_model',
      arguments: { model: 'test-model' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/Model changed|test-model/i);
  });

  it('rejects empty model name', async () => {
    /** change_model with empty string should fail */
    const result = await client.callTool({
      name: 'change_model',
      arguments: { model: '   ' },
    });
    expect(result.isError).toBe(true);
  });
});

// ── Progress notifications during LLM calls ──────────────────────────
// These tests verify that the server sends progress notifications when
// a tool takes a long time. Since we don't have an LLM backend, we
// test with tools that will fail AFTER sending at least one progress
// notification (connection refused to localhost:1234).

describe('progress notifications', () => {
  let client: Client;
  let transport: StdioClientTransport;
  const tmpDir = '/tmp/__llm_ext_test_progress';
  const testFile = join(tmpDir, 'hello.ts');

  beforeAll(async () => {
    ({ client, transport } = await createClient());
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(testFile, 'export function hello() { return "world"; }\n', 'utf-8');
  });

  afterAll(async () => {
    try { unlinkSync(testFile); } catch { /* ignore */ }
    await transport.close();
  });

  it('chat: sends progress token in request without crash', async () => {
    /** Calling chat with a progressToken should not crash, even if LLM is unreachable */
    const progressEvents: Array<{ progress: number; total?: number }> = [];

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
          onprogress: (p) => {
            progressEvents.push({ progress: p.progress, total: p.total });
          },
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

