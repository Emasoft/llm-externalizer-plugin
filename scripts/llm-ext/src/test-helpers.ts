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
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  type ResolvedProfile,
  HIGH_QUALITY_MODEL_DEFAULTS,
  validateSettings,
  resolveProfile,
  ensureSettingsExist,
  getSettingsPath,
  effectiveProfileName,
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
  // Short timeout ON PURPOSE. This backend is DELIBERATELY unreachable, and the
  // HTTP layer retries a network error 5 times with exponential backoff
  // (~1.2 + 1.9 + 3.9 + 7.1 + 16.2 ≈ 30s) — but that ladder is capped by the
  // profile's remaining time budget (provider/http.ts:40). Without this line the
  // profile inherits the long default, every unreachable-backend test spends
  // ~30s retrying something that can never succeed, and a test asserting "fails
  // cleanly within 10s" gets SIGKILLed and reports a null exit code — which
  // looks exactly like a hang.
  "    timeout: 5",
  "",
].join("\n");

function localTestResolvedProfile(timeoutSec: number): ResolvedProfile {
  return {
    name: LOCAL_TEST_PROFILE_NAME,
    profileType: "local",
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
    // A local test server: not billable, and not a free-by-nature REMOTE provider
    // (that flag is about paid-capable hosts that happen to charge nothing).
    isLocal: true,
    isFreeProvider: false,
    // Single-provider: no extra routes, so every model goes to the primary
    // backend — the behaviour every profile had before multi-provider existed.
    routes: [],
    routesFor: (): never[] => [],
    routeForModel: (): null => null,
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

  const activeName = effectiveProfileName(settings);
  const profile = settings.profiles[activeName];
  const resolved = resolveProfile(activeName, profile);
  const timeout = options.timeout ?? resolved.timeout;

  return { activeProfile: activeName, resolved, timeout, testName: options.testName, liveBackend: true };
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
  // mkdtempSync, not a fixed `${testName}`-based name: vitest runs test files
  // in parallel worker processes, so two files sharing a testName could race
  // — one call's `finally` rmSync'd the dir while another file's spawned CLI
  // was still writing its report into it (TRDD-90DM5YHO's cleanup made this
  // observable: the shared dir now gets deleted out from under the slower
  // call instead of silently accumulating).
  const outputDir = mkdtempSync(`/tmp/__llm_ext_${config.testName}_output_`);

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
  // P6 item 2: `--profile`'s omission now resolves to the built-in 'free'
  // default, NOT settings.yaml's (now-inert) `active:` key — so without this
  // flag every non-live call here would silently stop using the synthetic
  // LOCAL_TEST_PROFILE_NAME fixture and try the real 'free' (OpenRouter)
  // profile instead, which is both a correctness break for any test
  // asserting on the local-unreachable fixture's fields AND a COST-SAFETY
  // regression (a real OPENROUTER_API_KEY in the environment would let a
  // free-tier request actually go out). Pin it explicitly. Live-backend
  // calls are unaffected on purpose — a live suite exercises the real
  // settings.yaml exactly as an interactive user would invoke it, and an
  // interactive user gets the same 'free' default under item 2.
  if (!config.liveBackend) cliArgs.push("--profile", LOCAL_TEST_PROFILE_NAME);
  if (quiet) cliArgs.push("--quiet");

  try {
    const { stdout, stderr } = await execFileAsync("node", cliArgs, {
      env: {
        ...process.env,
        // Output .md files go to a temp dir so they don't accumulate
        LLM_EXT_OUTPUT_DIR: outputDir,
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
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | null;
      signal?: string | null;
      killed?: boolean;
    };
    // The CLI always writes the tool's error text to stderr (main.ts's
    // `die()` and the dispatch-error branch both do). stdout is the fallback
    // for a crash that happened before either wrote anything meaningful.
    //
    // A timeout kill sets `signal` and leaves `code` undefined, so the old
    // `e.code ?? null` turned "we killed it after N seconds" into a bare
    // `exitCode: null` and the assertion read "expected null to be +0" — a
    // message that names neither the timeout nor the command. Say what happened.
    const stderrText = (e.stderr ?? "").trim();
    const text = stderrText.length > 0 ? stderrText : (e.stdout ?? "").trim();
    return {
      content: [{ type: "text", text }],
      isError: true,
      stderr: e.signal
        ? `${e.stderr ?? ""}\n[test harness] child killed by ${e.signal}` +
          `${e.killed ? " (timeout)" : ""} — tool: ${toolName}`
        : e.stderr ?? "",
      exitCode: e.code ?? null,
    };
  } finally {
    // tmpConfigDir is a mkdtempSync-created per-call throwaway dir that nobody
    // reads after this call returns -- leaving it leaks one /tmp entry per test
    // assertion, and src/test-tmpdir-guard.ts fails the whole run on any
    // leftover `llm-ext`-named /tmp entry.
    //
    // outputDir is NOT removed here (TRDD-90DM5YHO follow-up): callers
    // (live.test.ts / live-extended.test.ts / live-websearch.test.ts) read the
    // report file out of it via `readFileSync(reportPath)` AFTER `await
    // runCli(...)` resolves -- rmSync'ing it here deleted it out from under
    // them before they ever got to read it (verified live: ENOENT). It is
    // still cleaned up: it's mkdtempSync-created, so
    // src/test-tmpdir-tracker.ts's afterAll removes it once the test file
    // finishes, after every caller has had its chance to read it.
    rmSync(tmpConfigDir, { recursive: true, force: true });
  }
}

// ── Help / CLI-shape tests ───────────────────────────────────────────────
// The help-rendering suites all need the same thing: the real compiled CLI,
// spawned against a throwaway config dir holding a local, unreachable profile.
// They each grew their own copy of it; this is the one copy.

/** One local, unreachable profile. `prof-a` is asserted on by name. */
const HELP_TEST_SETTINGS_YAML = [
  "active: prof-a",
  "profiles:",
  "  prof-a:",
  "    mode: local",
  "    api: generic-local",
  "    model: model-a",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "",
].join("\n");

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn the real compiled CLI (dist/llm-ext.js) against a THROWAWAY config dir
 * and return its streams. No mocking.
 *
 * The dir is removed in `finally`: a per-call mkdtemp that is never cleaned
 * leaves one /tmp directory behind per assertion, on every run, forever.
 */
export async function runCliInTempConfig(args: string[]): Promise<CliRunResult> {
  const tmpConfigDir = mkdtempSync("/tmp/__llm_ext_help_cfg_");
  writeFileSync(join(tmpConfigDir, "settings.yaml"), HELP_TEST_SETTINGS_YAML, "utf-8");
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_SCRIPT, ...args], {
      env: { ...process.env, LLM_EXT_CONFIG_DIR: tmpConfigDir, LLM_EXT_INSTALL_RULE: "0" },
      // 60s, not 15s: this spawns a cold Node process running the real CLI, and
      // the gate that runs it (publish.py) runs it while the machine is also
      // type-checking, linting and building. A 15s budget failed there while
      // passing every time in isolation. See c0a3b6f6 — the same fix, applied
      // to the file that hit it first; these never received it.
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      code?: number | null;
      signal?: string | null;
      killed?: boolean;
    };
    // A timeout kill sets `signal` and leaves `code` undefined, so the old
    // `e.code ?? null` turned "we killed it after N seconds" into a bare
    // `exitCode: null` and the assertion read "expected null to be +0" — a
    // message that names neither the timeout nor the command. Say what happened.
    const stderrText = (e.stderr ?? "").trim();
    return {
      stdout: (e.stdout ?? "").trim(),
      stderr: e.signal
        ? `${stderrText}\n[test harness] child killed by ${e.signal}` +
          `${e.killed ? " (timeout)" : ""} — args: ${args.join(" ")}`
        : stderrText,
      exitCode: e.code ?? null,
    };
  } finally {
    rmSync(tmpConfigDir, { recursive: true, force: true });
  }
}
