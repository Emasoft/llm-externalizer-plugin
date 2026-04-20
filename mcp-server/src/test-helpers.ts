/**
 * Shared test infrastructure for LLM Externalizer MCP server tests.
 *
 * Uses the real ~/.llm-externalizer/settings.yaml — the same file the
 * server uses. Tests exercise the real config pipeline with the real
 * backend configured by the user.
 *
 * Usage:
 *   import { resolveTestConfig, createTestClient } from './test-helpers';
 *   const config = resolveTestConfig({ testName: 'unit' });
 *   const { client, transport } = await createTestClient(config);
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ResolvedProfile,
  validateSettings,
  resolveProfile,
  ensureSettingsExist,
  getSettingsPath,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the compiled server entry point */
export const SERVER_SCRIPT = join(__dirname, "..", "dist", "index.js");

// ── Exported types and functions ─────────────────────────────────────

export interface TestConfig {
  /** Active profile name */
  activeProfile: string;
  /** Resolved profile with concrete connection values */
  resolved: ResolvedProfile;
  /** Timeout in seconds */
  timeout: number;
  /** Unique test suite name — used for output dir naming */
  testName: string;
}

export interface TestConfigOptions {
  /** Unique test suite name — used for output dir naming (e.g. 'unit', 'live', 'extended') */
  testName: string;
  /** Override timeout in seconds */
  timeout?: number;
}

/**
 * Reads the real settings.yaml (same file the server uses) and resolves
 * the active profile. Tests use the real configuration — no temp configs.
 */
export function resolveTestConfig(options: TestConfigOptions): TestConfig {
  const settings = ensureSettingsExist();
  const validation = validateSettings(settings);
  if (!validation.valid) {
    throw new Error(
      `Test config validation failed:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}\n` +
        `Settings file: ${getSettingsPath()}`,
    );
  }

  const profile = settings.profiles[settings.active];
  const resolved = resolveProfile(settings.active, profile);
  const timeout = options.timeout ?? resolved.timeout;

  return { activeProfile: settings.active, resolved, timeout, testName: options.testName };
}

/**
 * Create an MCP client connected to the server process.
 * The server reads its own settings.yaml — no env overrides needed.
 */
export async function createTestClient(
  config: TestConfig,
  clientName = "test-client",
): Promise<{ client: Client; transport: StdioClientTransport; timeoutMs: number }> {
  const outputDir = `/tmp/__llm_ext_${config.testName}_output`;
  const timeoutMs = config.timeout * 1000;

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_SCRIPT],
    env: {
      ...process.env,
      // Output .md files go to a temp dir so they don't accumulate
      LLM_OUTPUT_DIR: outputDir,
    },
    stderr: "pipe",
  });

  const client = new Client(
    { name: clientName, version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close();
    throw err;
  }
  return { client, transport, timeoutMs };
}
