/**
 * Shared test infrastructure for LLM Externalizer CLI tests.
 *
 * COST-SAFETY (TRDD-e82f2c49): by DEFAULT the spawned CLI is configured with
 * a synthetic LOCAL, unreachable backend, so the default `npm test` / publish
 * gate makes ZERO OpenRouter calls — tool calls fail-fast on ECONNREFUSED, which
 * is exactly what the integration tests assert ("does not crash"). Reading the
 * user's REAL backend (which costs money) is opt-in via `requireLiveBackend`,
 * and MUST only be used by `LIVE_TESTS`-gated suites.
 *
 * Usage (default — free, offline):
 *   const config = resolveTestConfig({ testName: 'unit' });
 *   const result = await runCli(config, 'discover');
 *
 * Usage (LIVE — real backend, costs money; gate the suite on LIVE_TESTS=1):
 *   const config = resolveTestConfig({ testName: 'live', requireLiveBackend: true });
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import {
  type ResolvedProfile,
  HIGH_QUALITY_MODEL_DEFAULTS,
  validateSettings,
  resolveProfile,
  ensureSettingsExist,
  getSettingsPath,
} from "./config.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the compiled CLI entry point (there is no MCP server any more). */
export const CLI_SCRIPT = join(__dirname, "..", "dist", "llm-ext.js");

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
    freeOnly: false,
    freeModels: [],
    toolModels: {},
    timeout: timeoutSec,
    contextWindow: 0,
    appName: "",
    httpReferer: "",
    highQualityModel: HIGH_QUALITY_MODEL_DEFAULTS,
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

/** Text-content result of one CLI invocation, shaped like the old MCP `ToolResult`
 * so call sites that inspected `result.content[0].text` / `result.isError`
 * need only swap the call, not the assertions. */
export interface CliResult {
  content: { type: "text"; text: string }[];
  isError: boolean;
  /** Raw stderr — banner + progress lines + (on error) the error text. */
  stderr: string;
  exitCode: number | null;
}

export interface RunCliOptions {
  /** Suppress the boot banner and progress lines. Default true — keeps
   * stderr limited to the error text so assertions on it stay precise. */
  quiet?: boolean;
  /** Override the per-call timeout (ms). Defaults to `config.timeout * 1000`. */
  timeoutMs?: number;
}

/** Turn a JS args object into `llm-ext` CLI flags. Flag names are passed
 * through as-is (snake_case, matching the tool's JSON-schema property names —
 * the CLI accepts that spelling directly). Non-primitive values are
 * JSON-encoded, which is exactly what the CLI's array/object coercion expects. */
function serializeFlags(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    out.push(`--${key}`);
    if (typeof value === "string") out.push(value);
    else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
    else out.push(JSON.stringify(value));
  }
  return out;
}

/**
 * Run one `llm-ext <command>` invocation as a subprocess, the same way a real
 * user would. Replaces the old MCP `createTestClient()` — there is no server
 * to connect to any more, only a CLI to spawn.
 *
 * COST-SAFETY (TRDD-e82f2c49): identical guard to the old client — by DEFAULT
 * writes a synthetic LOCAL, unreachable settings.yaml into a throwaway
 * `mkdtempSync("/tmp/__llm_ext_cfg_")` dir and passes it via
 * `LLM_EXT_CONFIG_DIR`, so the spawned process can NEVER bill OpenRouter. Only
 * `LIVE_TESTS`-gated suites (`config.liveBackend === true`) get the real
 * settings.yaml copied in. Do NOT switch this to an in-process call — the
 * subprocess boundary is exactly what makes the env-var isolation possible.
 */
export async function runCli(
  config: TestConfig,
  toolName: string,
  args: Record<string, unknown> = {},
  options: RunCliOptions = {},
): Promise<CliResult> {
  const quiet = options.quiet ?? true;
  const timeoutMs = options.timeoutMs ?? config.timeout * 1000;
  const outputDir = `/tmp/__llm_ext_${config.testName}_output`;

  // Isolate the spawned process's config dir so its usage-history.log (and any
  // settings-edit side effects) land in a throwaway /tmp dir instead of the
  // developer's real ~/.llm-externalizer/. /tmp (not os.tmpdir) because
  // getConfigDir() only permits $HOME or /tmp.
  //
  // COST-SAFETY (TRDD-e82f2c49): by DEFAULT write a synthetic LOCAL, unreachable
  // settings.yaml so the spawned process can NEVER bill OpenRouter — the previous
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

  const cliArgs = [CLI_SCRIPT, toolName, ...serializeFlags(args)];
  if (quiet) cliArgs.push("--quiet");

  try {
    const { stdout, stderr } = await execFileAsync("node", cliArgs, {
      env: {
        ...process.env,
        // Output .md files go to a temp dir so they don't accumulate
        LLM_OUTPUT_DIR: outputDir,
        // History + settings-edit side effects stay in the throwaway dir.
        LLM_EXT_CONFIG_DIR: tmpConfigDir,
        // Never let the spawned test process install the usage rule into the
        // real ~/.claude/rules/ (the startup installer is opt-out via this var).
        LLM_EXT_INSTALL_RULE: "0",
      },
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      content: [{ type: "text", text: stdout.trim() }],
      isError: false,
      stderr,
      exitCode: 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null };
    // The CLI always writes the tool's error text to stderr (main.ts's
    // `die()` and the dispatch-error branch both do). stdout is the fallback
    // for a crash that happened before either wrote anything meaningful.
    const stderrText = (e.stderr ?? "").trim();
    const text = stderrText.length > 0 ? stderrText : (e.stdout ?? "").trim();
    return {
      content: [{ type: "text", text }],
      isError: true,
      stderr: e.stderr ?? "",
      exitCode: e.code ?? null,
    };
  }
}
