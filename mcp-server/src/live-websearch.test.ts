/**
 * Web-search-based live integration tests — require LM Studio with web search MCP tools.
 *
 * These tests exercise LM Studio's ability to use MCP tools (web search + scrape)
 * during inference. The model is given ONLY a source file and asked to look up
 * the latest API documentation on the web, then compare the source against it.
 *
 * Prerequisites:
 *   - LM Studio running with a loaded model
 *   - Web search MCP tool configured in LM Studio (e.g., brave-search, tavily)
 *   - Web scrape MCP tool configured in LM Studio (e.g., fetch, jina-reader)
 *
 * Run with: npx vitest run src/live-websearch.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, unlinkSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, '..', 'dist', 'index.js');
const TMP_DIR = '/tmp/__llm_ext_websearch_test';
const MODEL = process.env.LM_STUDIO_MODEL || 'thecluster/qwen3.5-27b-mlx';

// Test-specific settings.yaml pointing to local LM Studio (profile-based format)
const TEST_CONFIG_DIR = '/tmp/__llm_ext_websearch_test_config';
mkdirSync(TEST_CONFIG_DIR, { recursive: true });
writeFileSync(join(TEST_CONFIG_DIR, 'settings.yaml'), [
  'active: websearch-lmstudio',
  'profiles:',
  '  websearch-lmstudio:',
  '    mode: local',
  '    api: lmstudio-local',
  `    model: "${MODEL}"`,
  '    url: "http://localhost:1234"',
  '    timeout: 600',
  '',
].join('\n'), 'utf-8');

// Remove both module-scope temp directories once the whole suite is done.
// Without this, repeated runs accumulate /tmp/__llm_ext_websearch_test and
// /tmp/__llm_ext_websearch_test_config. The per-suite afterAll hooks below
// only close transports — they do not clean the file-system state, and the
// module-scope mkdirSync above runs unconditionally on every import.
afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
  rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
});

function cleanDir(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(dir, { recursive: true });
}

async function createClient(): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_SCRIPT],
    env: {
      ...process.env,
      LLM_EXT_CONFIG_DIR: TEST_CONFIG_DIR,
      LLM_OUTPUT_DIR: join(TMP_DIR, 'output'),
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'websearch-test-client', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

function getText(result: unknown): string {
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return '';
  return (content[0] as { type: string; text: string } | undefined)?.text ?? '';
}

// ── Pre-flight: verify LM Studio is reachable ────────────────────────

describe('pre-flight (websearch)', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('LLM backend is reachable', async () => {
    /** discover should report the backend as online */
    const result = await client.callTool({ name: 'discover', arguments: {} });
    const text = getText(result);
    expect(text).not.toMatch(/OFFLINE/i);
    expect(text).toMatch(/ONLINE/i);
  });
});

// ── Web search deprecation test: React class components ──────────────
// Provides ONLY the source file — the model must search the web for
// the current React API and identify deprecated patterns.

describe('web search: React deprecation detection', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('detects deprecated React patterns by searching the web', async () => {
    /**
     * Given ONLY a source file with deprecated React class component patterns,
     * the model should use its web search MCP tools to find the current React
     * 18+ API and identify what's deprecated.
     */
    cleanDir(TMP_DIR);
    mkdirSync(join(TMP_DIR, 'output'), { recursive: true });

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
          instructions: [
            'You have web search tools available. Use them.',
            'Search the web for the official React 18+ migration guide and current API reference.',
            'Then compare this source file against the current React API.',
            'List every deprecated or removed API usage found in this file.',
            'For each finding, state: the deprecated call, why it is deprecated, and the modern replacement.',
            'Be concise — one line per finding.',
          ].join(' '),
          input_files_paths: sourceFile,
        },
      }, undefined, { timeout: 900_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);

      const report = readFileSync(reportPath, 'utf-8').toLowerCase();

      // Should identify key deprecated patterns even without bundled docs
      let matchCount = 0;
      if (report.match(/componentwillmount/)) matchCount++;
      if (report.match(/componentwillreceiveprops/)) matchCount++;
      if (report.match(/reactdom\.render|createroot/)) matchCount++;
      if (report.match(/this\.setstate|usestate/)) matchCount++;
      if (report.match(/ref="profilediv"|ref="|useref/)) matchCount++;
      if (report.match(/useeffect/)) matchCount++;

      // With web search, should find at least 3 of 6 deprecated patterns
      expect(matchCount).toBeGreaterThanOrEqual(3);
    } finally {
      try { unlinkSync(sourceFile); } catch { /* */ }
    }
  });
});

// ── Web search deprecation test: Express.js middleware ────────────────
// Tests with a different ecosystem to validate web search generality.

describe('web search: Express.js deprecation detection', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('detects deprecated Express.js patterns by searching the web', async () => {
    /**
     * Source file uses deprecated Express.js patterns (body-parser as separate
     * middleware, old error handling, deprecated res.send(status) syntax).
     * The model should search for current Express 4.x/5.x docs and identify them.
     */
    cleanDir(TMP_DIR);
    mkdirSync(join(TMP_DIR, 'output'), { recursive: true });

    const sourceFile = join(TMP_DIR, 'old-server.js');
    writeFileSync(sourceFile, [
      'const express = require("express");',
      'const bodyParser = require("body-parser");',
      '',
      'const app = express();',
      '',
      '// Using body-parser as separate middleware (deprecated since Express 4.16)',
      'app.use(bodyParser.json());',
      'app.use(bodyParser.urlencoded({ extended: true }));',
      '',
      '// Using deprecated res.send(status) signature',
      'app.get("/health", (req, res) => {',
      '  res.send(200);',
      '});',
      '',
      '// Using deprecated req.host (should be req.hostname)',
      'app.get("/info", (req, res) => {',
      '  res.json({ host: req.host, ip: req.ip });',
      '});',
      '',
      '// Using deprecated app.del() instead of app.delete()',
      'app.del("/users/:id", (req, res) => {',
      '  res.send(204);',
      '});',
      '',
      '// Using deprecated res.sendfile (lowercase f)',
      'app.get("/download", (req, res) => {',
      '  res.sendfile("/path/to/file.pdf");',
      '});',
      '',
      'app.listen(3000);',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'code_task',
        arguments: {
          instructions: [
            'You have web search tools available. Use them.',
            'Search the web for the current Express.js API documentation and migration guides.',
            'Then compare this source file against the current Express API.',
            'List every deprecated or removed API usage found in this file.',
            'For each finding, state: the deprecated call, why it is deprecated, and the modern replacement.',
            'Be concise — one line per finding.',
          ].join(' '),
          input_files_paths: sourceFile,
        },
      }, undefined, { timeout: 900_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);

      const report = readFileSync(reportPath, 'utf-8').toLowerCase();

      // Should identify key deprecated patterns
      let matchCount = 0;
      if (report.match(/body-?parser|bodyparser/)) matchCount++;
      if (report.match(/express\.json|built.?in/)) matchCount++;       // modern replacement
      if (report.match(/res\.send\(200\)|res\.sendstatus/)) matchCount++;
      if (report.match(/req\.host|req\.hostname/)) matchCount++;
      if (report.match(/app\.del|app\.delete/)) matchCount++;
      if (report.match(/sendfile|sendFile/)) matchCount++;

      // With web search, should find at least 3 of 6 deprecated patterns
      expect(matchCount).toBeGreaterThanOrEqual(3);
    } finally {
      try { unlinkSync(sourceFile); } catch { /* */ }
    }
  });
});

// ── Web search: latest API version check ─────────────────────────────
// Tests the model's ability to find the CURRENT version of a well-known
// library and verify whether the code uses up-to-date patterns.

describe('web search: Node.js API currency check', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => { ({ client, transport } = await createClient()); });
  afterAll(async () => { if (transport) await transport.close(); });

  it('identifies outdated Node.js patterns by checking current docs', async () => {
    /**
     * Source file uses Node.js patterns that were common in older versions
     * but have modern replacements (e.g., util.promisify vs native promises,
     * fs callbacks vs fs/promises, url.parse vs URL constructor).
     */
    cleanDir(TMP_DIR);
    mkdirSync(join(TMP_DIR, 'output'), { recursive: true });

    const sourceFile = join(TMP_DIR, 'legacy-utils.js');
    writeFileSync(sourceFile, [
      'const fs = require("fs");',
      'const url = require("url");',
      'const util = require("util");',
      'const path = require("path");',
      '',
      '// Using callback-based fs instead of fs/promises',
      'function readConfig(filePath) {',
      '  return new Promise((resolve, reject) => {',
      '    fs.readFile(filePath, "utf-8", (err, data) => {',
      '      if (err) reject(err);',
      '      else resolve(JSON.parse(data));',
      '    });',
      '  });',
      '}',
      '',
      '// Using url.parse instead of URL constructor',
      'function getHost(urlString) {',
      '  const parsed = url.parse(urlString);',
      '  return parsed.hostname;',
      '}',
      '',
      '// Using util.promisify for something that has a native promise version',
      'const readFileAsync = util.promisify(fs.readFile);',
      '',
      '// Using Buffer constructor (deprecated since Node 6)',
      'function createBuffer(str) {',
      '  return new Buffer(str);',
      '}',
      '',
      '// Using require("crypto").createCipher (deprecated, use createCipheriv)',
      'const crypto = require("crypto");',
      'function encrypt(text, key) {',
      '  const cipher = crypto.createCipher("aes-256-cbc", key);',
      '  return cipher.update(text, "utf8", "hex") + cipher.final("hex");',
      '}',
      '',
    ].join('\n'), 'utf-8');

    try {
      const result = await client.callTool({
        name: 'code_task',
        arguments: {
          instructions: [
            'You have web search tools available. Use them.',
            'Search the web for the current Node.js API documentation (latest LTS version).',
            'Then compare this source file against the current Node.js API.',
            'List every deprecated, outdated, or insecure API usage found in this file.',
            'For each finding, state: the deprecated call, why it is deprecated, and the modern replacement.',
            'Be concise — one line per finding.',
          ].join(' '),
          input_files_paths: sourceFile,
        },
      }, undefined, { timeout: 900_000 });

      expect(result.isError).toBeFalsy();
      const reportPath = getText(result);
      expect(reportPath).toMatch(/\.md$/);

      const report = readFileSync(reportPath, 'utf-8').toLowerCase();

      // Should identify key deprecated patterns
      let matchCount = 0;
      if (report.match(/url\.parse|new url/i)) matchCount++;
      if (report.match(/new buffer|buffer\.from/i)) matchCount++;
      if (report.match(/createcipher[^i]|createcipheriv/i)) matchCount++;
      if (report.match(/fs\/promises|fs\.promises/i)) matchCount++;
      if (report.match(/promisify|native.*promise/i)) matchCount++;
      if (report.match(/callback|readfile.*callback/i)) matchCount++;

      // With web search, should find at least 3 of 6 deprecated patterns
      expect(matchCount).toBeGreaterThanOrEqual(3);
    } finally {
      try { unlinkSync(sourceFile); } catch { /* */ }
    }
  });
});
