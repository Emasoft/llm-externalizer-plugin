/**
 * Shared test infrastructure for LLM Externalizer MCP server tests.
 *
 * COST-SAFETY (TRDD-e82f2c49): by DEFAULT the spawned server is configured with
 * a synthetic LOCAL, unreachable backend, so the default `npm test` / publish
 * gate makes ZERO OpenRouter calls — tool calls fail-fast on ECONNREFUSED, which
 * is exactly what the integration tests assert ("does not crash"). Reading the
 * user's REAL backend (which costs money) is opt-in via `requireLiveBackend`,
 * and MUST only be used by `LIVE_TESTS`-gated suites.
 *
 * Usage (default — free, offline):
 *   const config = resolveTestConfig({ testName: 'unit' });
 *   const { client, transport } = await createTestClient(config);
 *
 * Usage (LIVE — real backend, costs money; gate the suite on LIVE_TESTS=1):
 *   const config = resolveTestConfig({ testName: 'live', requireLiveBackend: true });
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
  /**
   * When true, the spawned server uses the user's REAL active backend (read
   * from ~/.llm-externalizer/settings.yaml). When false (the DEFAULT), it uses
   * a synthetic LOCAL, unreachable backend that can never bill OpenRouter —
   * cost-safety (TRDD-e82f2c49). Only deliberately-LIVE, `LIVE_TESTS`-gated
   * suites set this true.
   */
  liveBackend: boolean;
}

export interface TestConfigOptions {
  /** Unique test suite name — used for output dir naming (e.g. 'unit', 'live', 'extended') */
  testName: string;
  /** Override timeout in seconds */
  timeout?: number;
  /**
   * Opt into the user's REAL backend (costs money). DEFAULT false → a local,
   * unreachable backend so the default `npm test` / publish gate makes ZERO
   * OpenRouter calls (TRDD-e82f2c49). Set true ONLY in a `LIVE_TESTS`-gated suite.
   */
  requireLiveBackend?: boolean;
}

// ── Cost-safety: the default test backend (TRDD-e82f2c49) ────────────────
// A LOCAL profile NEVER contacts openrouter.ai (local mode → local URL), and
// port 1 is always connection-refused, so the default integration tests
// fail-fast on ECONNREFUSED — free, no billing, regardless of the user's real
// active profile. This restores index.test.ts's documented design ("connection
// refused to localhost:1234") which had drifted to billing the real backend.
const LOCAL_TEST_PROFILE_NAME = "test-local-unreachable";
const LOCAL_TEST_URL = "http://127.0.0.1:1";
const LOCAL_TEST_SETTINGS_YAML = [
  `active: ${LOCAL_TEST_PROFILE_NAME}`,
  "profiles:",
  `  ${LOCAL_TEST_PROFILE_NAME}:`,
  "    mode: local",
  "    api: generic-local",
  "    model: test-model",
  `    url: ${LOCAL_TEST_URL}`,
  "",
].join("\n");

function localTestResolvedProfile(timeoutSec: number): ResolvedProfile {
  return {
    name: LOCAL_TEST_PROFILE_NAME,
    mode: "local",
    protocol: "openai_api",
    url: LOCAL_TEST_URL,
    model: "test-model",
    authToken: "",
    secondModel: "",
    thirdModel: "",
    toolModels: {},
    timeout: timeoutSec,
    contextWindow: 0,
    appName: "",
    httpReferer: "",
  };
}

/**
 * Resolve a backend for tests. DEFAULT: a synthetic LOCAL, unreachable backend
 * that can never bill OpenRouter (cost-safety, TRDD-e82f2c49). Only when
 * `requireLiveBackend` is true does it read the real ~/.llm-externalizer/
 * settings.yaml and resolve the user's active profile — that path MUST be used
 * solely by `LIVE_TESTS`-gated suites, because it spends real money.
 */
export function resolveTestConfig(options: TestConfigOptions): TestConfig {
  if (!options.requireLiveBackend) {
    const timeout = options.timeout ?? 120;
    return {
      activeProfile: LOCAL_TEST_PROFILE_NAME,
      resolved: localTestResolvedProfile(timeout),
      timeout,
      testName: options.testName,
      liveBackend: false,
    };
  }

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

  return { activeProfile: settings.active, resolved, timeout, testName: options.testName, liveBackend: true };
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

  // Isolate the spawned server's config dir so its usage-history.log (and any
  // settings-edit side effects) land in a throwaway /tmp dir instead of the
  // developer's real ~/.llm-externalizer/. /tmp (not os.tmpdir) because
  // getConfigDir() only permits $HOME or /tmp.
  //
  // COST-SAFETY (TRDD-e82f2c49): by DEFAULT write a synthetic LOCAL, unreachable
  // settings.yaml so the spawned server can NEVER bill OpenRouter — the previous
  // behavior (copy the real settings.yaml) made every integration-test tool call
  // hit the user's real, possibly premium, remote backend. Only LIVE-gated
  // suites (config.liveBackend === true) get the real backend.
  const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_cfg_");
  if (config.liveBackend) {
    const realSettingsPath = getSettingsPath();
    if (existsSync(realSettingsPath)) {
      copyFileSync(realSettingsPath, join(tmpConfigDir, "settings.yaml"));
    }
  } else {
    writeFileSync(join(tmpConfigDir, "settings.yaml"), LOCAL_TEST_SETTINGS_YAML, "utf-8");
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER_SCRIPT],
    env: {
      ...process.env,
      // Output .md files go to a temp dir so they don't accumulate
      LLM_OUTPUT_DIR: outputDir,
      // History + settings-edit side effects stay in the throwaway dir.
      LLM_EXT_CONFIG_DIR: tmpConfigDir,
      // Never let the spawned test server install the usage rule into the real
      // ~/.claude/rules/ (the startup installer is opt-out via this var).
      LLM_EXT_INSTALL_RULE: "0",
    },
    stderr: "pipe",
  });

  // Drain the server's stderr into the parent's stderr. If we leave the
  // piped stderr unconsumed, the PassThrough buffer fills, backpressure
  // propagates to the child's stderr, the OS pipe buffer (~64 KB) fills,
  // and the server blocks on its next `process.stderr.write(...)` — which
  // hangs the entire test. Attach the consumer BEFORE connect() so no
  // early startup output is lost.
  transport.stderr?.pipe(process.stderr);

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
