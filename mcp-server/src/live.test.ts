/**
 * Live integration tests — require a running LLM backend (LM Studio / Ollama).
 *
 * These tests exercise real LLM round-trips: chat, code_task, and verify
 * that MCP progress notifications are sent during streaming.
 *
 * Run with: LM_STUDIO_MODEL=thecluster/qwen3.5-27b-mlx npx vitest run src/live.test.ts
 * Skip with: npx vitest run --exclude src/live.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'node:fs';
import { resolveTestConfig, createTestClient } from './test-helpers';

const TMP_DIR = '/tmp/__llm_ext_live_test';

// Resolve live test config from real settings.yaml.
// Uses whatever the user configured. timeout: 300s for reasoning models.
const testConfig = resolveTestConfig({ testName: 'live', timeout: 300 });

async function createClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  return createTestClient(testConfig, 'live-test-client');
}

// ── Pre-flight check ─────────────────────────────────────────────────

describe('pre-flight', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('LLM backend is reachable', async () => {
    /** discover should report the backend as online */
    const result = await client.callTool({ name: 'discover', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toBeDefined();
    // Should NOT say OFFLINE
    expect(text).not.toMatch(/OFFLINE/i);
    // Backend type is shown in server startup log, not necessarily in discover output
    expect(text).toMatch(/ONLINE/i);
  });
});

// ── chat tool — real LLM round-trip ──────────────────────────────────

describe('chat (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('returns a response for a simple prompt', async () => {
    /** chat with a simple prompt should return non-empty text */
    const result = await client.callTool({
      name: 'chat',
      arguments: {
        instructions: 'Reply with exactly: "Hello from LLM" — nothing else. Do not think or reason, just reply.',

      },
    }, undefined, { timeout: 600_000 });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toBeDefined();
    // Should return a file path (the output .md file)
    expect(text).toMatch(/\.md$/);
  });

  it('sends progress notifications during long calls', async () => {
    /** chat should send progress notifications when progressToken is provided */
    const progressEvents: Array<{ progress: number; total?: number; message?: string }> = [];

    const result = await client.callTool(
      {
        name: 'chat',
        arguments: {
          instructions: 'Say hello',
        },
      },
      undefined,
      {
        onprogress: (p) => {
          progressEvents.push({
            progress: p.progress,
            total: p.total,
            message: p.message,
          });
        },
        timeout: 600_000,
      },
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
    expect(text).toMatch(/\.md$/);

    // Local reasoning models take 20-30s per call, so we should always
    // get at least the initial progress notification and 1-2 periodic ones.
    expect(progressEvents.length).toBeGreaterThan(0);
    for (const evt of progressEvents) {
      expect(evt.progress).toBeGreaterThanOrEqual(0);
      expect(evt.progress).toBeLessThanOrEqual(100);
      expect(evt.total).toBe(100);
      expect(evt.message).toBeDefined();
      // Accept either streaming or native API progress messages
      expect(evt.message).toMatch(/Streaming|Waiting|LM Studio|Sending/);
    }
  });

  it('reads a file and analyzes it', async () => {
    /** chat with input_files_paths should read the file and respond about it */
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = join(TMP_DIR, 'sample.ts');
    writeFileSync(filePath, 'export function add(a: number, b: number): number {\n  return a + b;\n}\n', 'utf-8');

    try {
      const result = await client.callTool({
        name: 'chat',
        arguments: {
          instructions: 'What does this function do? Reply in one sentence.',
          input_files_paths: filePath,
  
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toMatch(/\.md$/);
    } finally {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  });
});

// ── code_task tool — real LLM round-trip ─────────────────────────────

describe('code_task (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('analyzes a code file for bugs', async () => {
    /** code_task should analyze a file and return a report */
    mkdirSync(TMP_DIR, { recursive: true });
    const filePath = join(TMP_DIR, 'buggy.ts');
    writeFileSync(filePath, [
      'export function divide(a: number, b: number): number {',
      '  return a / b; // potential division by zero',
      '}',
      '',
      'export function getFirst(arr: string[]) {',
      '  return arr[0].toUpperCase(); // potential null access',
      '}',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'code_task',
        arguments: {
          instructions: 'List bugs in this code in 2 sentences max.',
          input_files_paths: filePath,
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toMatch(/\.md$/);

      // Read the report to verify it mentions the bugs
      const report = readFileSync(text, 'utf-8');
      // Should mention division by zero or null/undefined access
      expect(report.toLowerCase()).toMatch(/divis|zero|null|undefined|empty|length/);
    } finally {
      try { unlinkSync(filePath); } catch { /* ignore */ }
    }
  });
});

// ── compare_files tool — real LLM round-trip ─────────────────────────

describe('compare_files (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('compares two files and describes differences', async () => {
    /** compare_files should auto-diff and describe changes */
    mkdirSync(TMP_DIR, { recursive: true });
    const fileA = join(TMP_DIR, 'old.ts');
    const fileB = join(TMP_DIR, 'new.ts');
    writeFileSync(fileA, 'export const VERSION = "1.0.0";\nexport function hello() { return "hi"; }\n', 'utf-8');
    writeFileSync(fileB, 'export const VERSION = "2.0.0";\nexport function hello() { return "hello world"; }\nexport function goodbye() { return "bye"; }\n', 'utf-8');

    try {
      const result = await client.callTool({
        name: 'compare_files',
        arguments: {
          input_files_paths: [fileA, fileB],
          instructions: 'Summarize the changes. Be concise.',

        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toMatch(/\.md$/);

      // Read the report
      const report = readFileSync(text, 'utf-8');
      // Should mention the version change or the new function
      expect(report.toLowerCase()).toMatch(/version|2\.0\.0|goodbye|added|changed|new/);
    } finally {
      try { unlinkSync(fileA); } catch { /* ignore */ }
      try { unlinkSync(fileB); } catch { /* ignore */ }
    }
  });
});

// ── batch_check tool — real LLM round-trip ───────────────────────────

describe('batch_check (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    ({ client, transport } = await createClient());
  });

  afterAll(async () => {
    if (transport) await transport.close();
  });

  it('checks multiple files and reports per-file progress', async () => {
    /** batch_check should process each file and send batch-level progress */
    mkdirSync(TMP_DIR, { recursive: true });
    const file1 = join(TMP_DIR, 'mod1.ts');
    const file2 = join(TMP_DIR, 'mod2.ts');
    writeFileSync(file1, 'export function double(x: number) { return x * 2; }\n', 'utf-8');
    writeFileSync(file2, 'export function triple(x: number) { return x * 3; }\n', 'utf-8');

    const progressEvents: Array<{ progress: number; total?: number; message?: string }> = [];

    try {
      const result = await client.callTool(
        {
          name: 'batch_check',
          arguments: {
            input_files_paths: [file1, file2],
            instructions: 'Check for bugs. Reply in 1-2 sentences.',

          },
        },
        undefined,
        {
          onprogress: (p) => {
            progressEvents.push({
              progress: p.progress,
              total: p.total,
              message: p.message,
            });
          },
          timeout: 600_000,
        },
      );

      expect(result.isError).toBeFalsy();
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
      expect(text).toMatch(/\.md$/);

      // At least one progress notification (batch or streaming) must arrive.
      expect(progressEvents.length).toBeGreaterThan(0);

      // Check for batch progress notifications
      const batchProgress = progressEvents.filter(e => e.message?.includes('batch_check'));
      // With 2 files, at least 1 batch progress event must arrive (after each file completes)
      expect(batchProgress.length).toBeGreaterThan(0);
      for (const evt of batchProgress) {
        expect(evt.total).toBe(2); // 2 files total
        expect(evt.message).toMatch(/batch_check.*files done/);
      }
    } finally {
      try { unlinkSync(file1); } catch { /* ignore */ }
      try { unlinkSync(file2); } catch { /* ignore */ }
    }
  });
});
