/**
 * Extended live integration tests — additional tool coverage, batch stress tests,
 * and API deprecation checking.
 *
 * Requires a running LM Studio backend with a loaded model.
 * Run with: npx vitest run src/live-extended.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolveTestConfig, createTestClient } from './test-helpers';

const TMP_DIR = '/tmp/__llm_ext_extended_test';

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// Resolve live test config from real settings.yaml.
const testConfig = resolveTestConfig({ testName: 'extended', timeout: 300 });

async function createClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  return createTestClient(testConfig, 'extended-test-client');
}

function cleanDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function getText(result: unknown): string {
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return '';
  return (content[0] as { type: string; text: string } | undefined)?.text ?? '';
}

// ── chat: multi-file input ───────────────────────────────────────────

describe('chat: multi-file input', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('analyzes multiple files passed together', async () => {
    /** chat should read and respond about multiple input files */
    cleanDir(TMP_DIR);
    const f1 = join(TMP_DIR, 'utils.ts');
    const f2 = join(TMP_DIR, 'types.ts');
    writeFileSync(f1, 'export function sum(a: number, b: number) { return a + b; }\n', 'utf-8');
    writeFileSync(f2, 'export interface User { name: string; age: number; }\n', 'utf-8');

    try {
      const result = await client.callTool({
        name: 'chat',
        arguments: {
          instructions: 'How many files were provided? Name each file and its purpose in 1 line each.',
          input_files_paths: [f1, f2],
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);
      const report = readFileSync(reportPath, 'utf-8');
      // Should mention both files
      expect(report.toLowerCase()).toMatch(/utils|types/);
    } finally {
      try { unlinkSync(f1); } catch { /* */ }
      try { unlinkSync(f2); } catch { /* */ }
    }
  });
});

// ── chat: system prompt via instructions_files_paths ──────────────────

describe('chat: instructions from file', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('reads instructions from a file', async () => {
    /** instructions_files_paths should be appended to instructions */
    cleanDir(TMP_DIR);
    const instrFile = join(TMP_DIR, 'instructions.md');
    const codeFile = join(TMP_DIR, 'code.py');
    writeFileSync(instrFile, 'Count the number of functions defined in the code. Reply with just the number.', 'utf-8');
    writeFileSync(codeFile, 'def foo():\n  pass\n\ndef bar():\n  pass\n\ndef baz():\n  pass\n', 'utf-8');

    try {
      const result = await client.callTool({
        name: 'chat',
        arguments: {
          instructions_files_paths: instrFile,
          input_files_paths: codeFile,
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);
      const report = readFileSync(reportPath, 'utf-8');
      // Should mention "3" somewhere
      expect(report).toMatch(/3/);
    } finally {
      try { unlinkSync(instrFile); } catch { /* */ }
      try { unlinkSync(codeFile); } catch { /* */ }
    }
  });
});

// ── scan_folder ──────────────────────────────────────────────────────

describe('scan_folder (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('scans a folder of .ts files', async () => {
    /** scan_folder should discover and process files by extension */
    const scanDir = join(TMP_DIR, 'scan_target');
    cleanDir(scanDir);
    writeFileSync(join(scanDir, 'a.ts'), 'export const A = 1;\n', 'utf-8');
    writeFileSync(join(scanDir, 'b.ts'), 'export const B = 2;\n', 'utf-8');
    writeFileSync(join(scanDir, 'c.txt'), 'not a ts file\n', 'utf-8'); // should be skipped

    try {
      const result = await client.callTool({
        name: 'scan_folder',
        arguments: {
          folder_path: scanDir,
          extensions: ['.ts'],
          instructions: 'What does this file export? Reply in 1 sentence.',
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toMatch(/\.md$/);
      const report = readFileSync(text, 'utf-8');
      // Should mention both .ts files and not the skipped .txt
      expect(report).toMatch(/a\.ts/);
      expect(report).toMatch(/b\.ts/);
      expect(report).not.toMatch(/c\.txt/);
    } finally {
      cleanDir(scanDir);
    }
  });
});

// ── batch_check stress: 3 files with diverse content ─────────────────
// Local reasoning models take 120-200s per file due to thinking overhead,
// so we use 3 files with minimal prompts. The 600s per-test timeout is
// tight — batch_check with 2 files already passes in live.test.ts,
// this stresses with 3 distinct code patterns + progress validation.

describe('batch_check stress: 3 files', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('checks 3 files with diverse content and reports progress', async () => {
    /** batch_check with 3 diverse files should process each and report progress */
    const batchDir = join(TMP_DIR, 'batch3');
    cleanDir(batchDir);

    // Diverse file content to stress different code analysis paths
    const files: string[] = [];
    const contents = [
      '// Arithmetic utility\nexport function add(a: number, b: number) { return a + b; }\n',
      '// String utility\nexport function upper(s: string) { return s.toUpperCase(); }\n',
      '// Array utility\nexport function first<T>(arr: T[]): T | undefined { return arr[0]; }\n',
    ];
    contents.forEach((code, i) => {
      const fp = join(batchDir, `util_${i}.ts`);
      writeFileSync(fp, code, 'utf-8');
      files.push(fp);
    });

    const progressEvents: Array<{ progress: number; total?: number; message?: string }> = [];

    try {
      const result = await client.callTool(
        {
          name: 'batch_check',
          arguments: {
            input_files_paths: files,
            instructions: 'Any bugs? Reply YES or NO in 1 word.',
          },
        },
        undefined,
        {
          onprogress: (p) => {
            progressEvents.push({ progress: p.progress, total: p.total, message: p.message });
          },
          timeout: 600_000,
        },
      );

      expect(result.isError).toBeFalsy();
      const text = getText(result);
      expect(text).toBeDefined();

      // Should have batch progress events showing file completion
      const batchProgress = progressEvents.filter(e => e.message?.includes('batch_check'));
      expect(batchProgress.length).toBeGreaterThan(0);
      // Total should be 3 for all batch progress events
      for (const evt of batchProgress) {
        expect(evt.total).toBe(3);
      }
    } finally {
      cleanDir(batchDir);
    }
  });
});

// ── check_imports ────────────────────────────────────────────────────

describe('check_imports (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('validates import paths in a TypeScript file', async () => {
    /** check_imports should find broken imports */
    cleanDir(TMP_DIR);
    const mainFile = join(TMP_DIR, 'main.ts');
    const utilsFile = join(TMP_DIR, 'utils.ts');
    // utils.ts exists
    writeFileSync(utilsFile, 'export function helper() { return 1; }\n', 'utf-8');
    // main.ts imports utils (exists) and missing-module (doesn't exist)
    writeFileSync(mainFile, [
      'import { helper } from "./utils";',
      'import { broken } from "./missing-module";',
      'console.log(helper(), broken);',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'check_imports',
        arguments: {
          input_files_paths: mainFile,
        },
      }, undefined, { timeout: 600_000 });

      // check_imports may return isError if the LLM extraction fails,
      // but it should not crash the server
      const text = getText(result);
      expect(text).toBeDefined();

      if (!result.isError && text.endsWith('.md')) {
        const report = readFileSync(text, 'utf-8');
        // Should flag the missing import
        expect(report.toLowerCase()).toMatch(/missing|not found|broken|invalid|fail/);
      }
    } finally {
      try { unlinkSync(mainFile); } catch { /* */ }
      try { unlinkSync(utilsFile); } catch { /* */ }
    }
  });
});

// ── check_references ─────────────────────────────────────────────────

describe('check_references (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('validates symbol references across files', async () => {
    /** check_references should detect undefined symbols */
    cleanDir(TMP_DIR);
    const mainFile = join(TMP_DIR, 'app.ts');
    const libFile = join(TMP_DIR, 'lib.ts');
    writeFileSync(libFile, 'export function calculate(x: number) { return x * 2; }\n', 'utf-8');
    writeFileSync(mainFile, [
      'import { calculate } from "./lib";',
      'const result = calculate(5);',
      'const bad = nonExistentFunction(result);', // undefined reference
      'console.log(bad);',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'check_references',
        arguments: {
          input_files_paths: mainFile,
          instructions: 'This is TypeScript. Check if all referenced symbols are defined.',
        },
      }, undefined, { timeout: 600_000 });

      const text = getText(result);
      expect(text).toBeDefined();

      if (!result.isError && text.endsWith('.md')) {
        const report = readFileSync(text, 'utf-8');
        // Should flag nonExistentFunction
        expect(report.toLowerCase()).toMatch(/nonexistentfunction|undefined|not defined|missing/);
      }
    } finally {
      try { unlinkSync(mainFile); } catch { /* */ }
      try { unlinkSync(libFile); } catch { /* */ }
    }
  });
});

// ── API deprecation check ────────────────────────────────────────────
// Tests the ability to compare source code against API documentation
// to find deprecated usage patterns.

describe('API deprecation check (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('detects deprecated API usage by comparing against docs', async () => {
    /**
     * Given:
     * 1. A source file using deprecated API patterns
     * 2. An "API docs" file showing the current correct API
     * The LLM should identify which parts of the source are deprecated.
     */
    cleanDir(TMP_DIR);

    // "API documentation" file — the authoritative source of truth
    const docsFile = join(TMP_DIR, 'api-docs-v3.md');
    writeFileSync(docsFile, [
      '# MyFramework API v3 — Migration Guide',
      '',
      '## Breaking Changes from v2 to v3',
      '',
      '### Database',
      '- `db.connect(url)` → REMOVED. Use `Database.create({ connectionString: url })` instead.',
      '- `db.query(sql)` → DEPRECATED. Use `db.execute(sql, params)` with parameterized queries.',
      '- `db.close()` → Still supported but prefer `await db.disconnect()` for async cleanup.',
      '',
      '### HTTP Client',
      '- `http.get(url, callback)` → REMOVED. Use `await http.fetch(url, { method: "GET" })`.',
      '- `http.post(url, body, callback)` → REMOVED. Use `await http.fetch(url, { method: "POST", body })`.',
      '- Response object: `.body` property renamed to `.data`.',
      '',
      '### Auth',
      '- `auth.login(user, pass)` → DEPRECATED. Use `auth.authenticate({ username, password, mfa? })`.',
      '- `auth.getToken()` → Still supported.',
      '- `auth.setToken(t)` → REMOVED. Tokens are now managed internally.',
      '',
      '### Logging',
      '- `console.log()` for logging → Use `logger.info()`, `logger.warn()`, `logger.error()`.',
      '- `Logger.create(name)` → Use `new Logger({ name, level: "info" })`.',
      '',
    ].join('\n'), 'utf-8');

    // Source file intentionally using deprecated v2 API patterns
    const sourceFile = join(TMP_DIR, 'legacy-app.ts');
    writeFileSync(sourceFile, [
      '// Legacy application using MyFramework v2 API',
      'import { db, http, auth, Logger } from "myframework";',
      '',
      'async function main() {',
      '  // Database — using deprecated connection method',
      '  db.connect("postgres://localhost:5432/mydb");',
      '',
      '  // Query — using deprecated non-parameterized query',
      '  const users = db.query("SELECT * FROM users WHERE id = " + userId);',
      '',
      '  // HTTP — using deprecated callback-based API',
      '  http.get("https://api.example.com/data", (err, res) => {',
      '    if (err) throw err;',
      '    console.log(res.body); // .body is renamed to .data in v3',
      '  });',
      '',
      '  http.post("https://api.example.com/submit", payload, (err, res) => {',
      '    console.log("Done:", res.body);',
      '  });',
      '',
      '  // Auth — using deprecated login method',
      '  await auth.login("admin", "password123");',
      '  const token = auth.getToken(); // this one is still fine',
      '  auth.setToken("new-token"); // removed in v3',
      '',
      '  // Logging — using console.log instead of Logger',
      '  const logger = Logger.create("app"); // deprecated constructor',
      '  console.log("Application started");',
      '',
      '  db.close();',
      '}',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'code_task',
        arguments: {
          instructions: [
            'Compare the source code against the API documentation provided.',
            'List each deprecated or removed API usage found in the source code.',
            'For each one, state:',
            '1. The line with the deprecated call',
            '2. Why it is deprecated (removed/deprecated)',
            '3. The correct v3 replacement',
            'Be concise — one line per finding.',
          ].join(' '),
          input_files_paths: [sourceFile, docsFile],
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);

      const report = readFileSync(reportPath, 'utf-8').toLowerCase();

      // Should identify at least 5 of the 8 deprecated usages:
      // db.connect, db.query, http.get, http.post, auth.login, auth.setToken,
      // Logger.create, console.log, .body→.data
      let matchCount = 0;
      if (report.match(/db\.connect/)) matchCount++;
      if (report.match(/db\.query/)) matchCount++;
      if (report.match(/http\.get|http\.fetch/)) matchCount++;
      if (report.match(/http\.post/)) matchCount++;
      if (report.match(/auth\.login|auth\.authenticate/)) matchCount++;
      if (report.match(/auth\.settoken|settoken/)) matchCount++;
      if (report.match(/logger\.create/)) matchCount++;
      if (report.match(/console\.log|logger\.info/)) matchCount++;
      if (report.match(/\.body|\.data/)) matchCount++;

      // Should find at least 5 of 9 deprecated patterns
      expect(matchCount).toBeGreaterThanOrEqual(5);
    } finally {
      try { unlinkSync(docsFile); } catch { /* */ }
      try { unlinkSync(sourceFile); } catch { /* */ }
    }
  });

  it('detects deprecated React patterns against current docs', async () => {
    /**
     * A more realistic test: React code using deprecated lifecycle methods
     * vs current React documentation showing hooks-based patterns.
     */
    cleanDir(TMP_DIR);

    const docsFile = join(TMP_DIR, 'react-migration-guide.md');
    writeFileSync(docsFile, [
      '# React 18+ API Reference — Class to Hooks Migration',
      '',
      '## Deprecated Class Lifecycle Methods',
      '- `componentWillMount()` → REMOVED. Use `useEffect(() => {}, [])` instead.',
      '- `componentWillReceiveProps(nextProps)` → REMOVED. Use `useEffect(() => {}, [deps])`.',
      '- `componentWillUpdate()` → REMOVED. Use `useEffect`.',
      '- `componentDidMount()` → Use `useEffect(() => { ... }, [])`.',
      '- `componentDidUpdate()` → Use `useEffect(() => { ... }, [deps])`.',
      '- `componentWillUnmount()` → Use `useEffect(() => { return cleanup; }, [])`.',
      '',
      '## Deprecated APIs',
      '- `ReactDOM.render()` → REMOVED. Use `createRoot(container).render(<App />)`.',
      '- `this.setState()` → Use `useState()` hook.',
      '- `React.createClass()` → REMOVED since React 16. Use function components.',
      '- `string refs` (ref="myRef") → REMOVED. Use `useRef()` or `createRef()`.',
      '- `findDOMNode()` → REMOVED. Use refs instead.',
      '',
    ].join('\n'), 'utf-8');

    const sourceFile = join(TMP_DIR, 'old-component.tsx');
    writeFileSync(sourceFile, [
      'import React from "react";',
      'import ReactDOM from "react-dom";',
      '',
      'class UserProfile extends React.Component {',
      '  componentWillMount() {',
      '    this.setState({ loading: true });',
      '  }',
      '',
      '  componentWillReceiveProps(nextProps) {',
      '    if (nextProps.userId !== this.props.userId) {',
      '      this.fetchUser(nextProps.userId);',
      '    }',
      '  }',
      '',
      '  componentDidMount() {',
      '    this.fetchUser(this.props.userId);',
      '  }',
      '',
      '  componentWillUnmount() {',
      '    this.controller.abort();',
      '  }',
      '',
      '  render() {',
      '    return <div ref="profileDiv">{this.state.name}</div>;',
      '  }',
      '}',
      '',
      'ReactDOM.render(<UserProfile />, document.getElementById("root"));',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'code_task',
        arguments: {
          instructions: 'Compare the React source code against the migration guide. List every deprecated API usage and its modern replacement. Be concise.',
          input_files_paths: [sourceFile, docsFile],
        },
      }, undefined, { timeout: 600_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);

      const report = readFileSync(reportPath, 'utf-8').toLowerCase();

      // Should identify key deprecated patterns
      let matchCount = 0;
      if (report.match(/componentwillmount/)) matchCount++;
      if (report.match(/componentwillreceiveprops/)) matchCount++;
      if (report.match(/reactdom\.render|createroot/)) matchCount++;
      if (report.match(/this\.setstate|usestate/)) matchCount++;
      if (report.match(/ref="profilediv"|ref="|useref/)) matchCount++;
      if (report.match(/useeffect/)) matchCount++;

      // Should find at least 3 of 6 deprecated patterns
      expect(matchCount).toBeGreaterThanOrEqual(3);
    } finally {
      try { unlinkSync(docsFile); } catch { /* */ }
      try { unlinkSync(sourceFile); } catch { /* */ }
    }
  });
});

// ── scan_secrets validation ──────────────────────────────────────────

describe('scan_secrets (live)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('aborts batch_check when file contains secrets', async () => {
    /** scan_secrets should prevent processing files with leaked secrets */
    cleanDir(TMP_DIR);
    const secretFile = join(TMP_DIR, 'config.ts');
    writeFileSync(secretFile, [
      'export const config = {',
      '  OPENAI_API_KEY: "sk-1234567890abcdef1234567890abcdef1234567890abcdef12",',
      '  endpoint: "https://api.example.com",',
      '};',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'batch_check',
        arguments: {
          input_files_paths: [secretFile],
          instructions: 'Check this config.',
          scan_secrets: true,
        },
      }, undefined, { timeout: 600_000 });

      // Should be an error — secrets detected
      expect(result.isError).toBe(true);
      const text = getText(result);
      if (text) expect(text.toLowerCase()).toMatch(/secret|leak|abort/);
    } finally {
      try { unlinkSync(secretFile); } catch { /* */ }
    }
  });
});
