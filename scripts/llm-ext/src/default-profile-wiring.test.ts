/**
 * Wiring tests for Phase 4 of the dynamic default profiles (TRDD plan
 * "robust-giggling-dusk"): the boot gate (index.ts's IIFE around
 * validateSettings) and the dispatcher hook (dispatchCallToolInner, beside
 * runModelReconcile()) that together make the machine-owned default profiles
 * ('free' | 'free-ensemble' | 'paid' | 'paid-ensemble' | 'paid-mass-scout')
 * actually populate on first use instead of sitting inert.
 *
 * Hermetic: no network (global fetch is stubbed), no spend, no real spawn
 * (default-profiles-runner.js's populateDefaultProfile is mocked — index.ts
 * never gets a chance to shell out to a real benchmark child process).
 *
 * index.ts's boot IIFE runs its decision once, at module import time, from
 * whatever settings.yaml + LLM_EXT_CONFIG_DIR are in effect then — so every
 * test that needs a specific settings.yaml writes it to a fresh temp config
 * dir, calls vi.resetModules(), and dynamically re-imports index.ts. Mocks
 * registered via vi.mock are hoisted and stay wired across resetModules(), so
 * every fresh import of index.ts picks them up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PopulationOutcome } from "./default-profiles-runner";

const { populateDefaultProfileMock, getProfileRecordMock, readModelEventsMock } = vi.hoisted(
  () => ({
    populateDefaultProfileMock: vi.fn(),
    getProfileRecordMock: vi.fn(),
    readModelEventsMock: vi.fn(),
  }),
);

vi.mock("./default-profiles-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./default-profiles-runner")>();
  return { ...actual, populateDefaultProfile: populateDefaultProfileMock };
});

vi.mock("./default-profiles-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./default-profiles-state")>();
  return { ...actual, getProfileRecord: getProfileRecordMock };
});

vi.mock("./model-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-events")>();
  return { ...actual, readModelEvents: readModelEventsMock };
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const UNPOPULATED_FREE_YAML = `active: free
allow_paid_models: false
profiles:
  free:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: []
    model: placeholder/unpopulated-default-profile
    api_key: "$OPENROUTER_API_KEY"
`;

const UNPOPULATED_PAID_ENSEMBLE_YAML = `active: paid-ensemble
allow_paid_models: false
profiles:
  paid-ensemble:
    mode: remote-ensemble
    api: openrouter-remote
    model: placeholder/unpopulated-default-profile
    second_model: placeholder/unpopulated-default-profile
    third_model: placeholder/unpopulated-default-profile
    api_key: "$OPENROUTER_API_KEY"
`;

const UNPOPULATED_PAID_ENSEMBLE_ALLOW_PAID_YAML = UNPOPULATED_PAID_ENSEMBLE_YAML.replace(
  "allow_paid_models: false",
  "allow_paid_models: true",
);

const POPULATED_MASS_SCOUT_YAML = (modelId: string) => `active: paid-mass-scout
allow_paid_models: true
profiles:
  paid-mass-scout:
    mode: remote
    api: openrouter-remote
    model: ${modelId}
    api_key: "$OPENROUTER_API_KEY"
`;

const MISCONFIGURED_CUSTOM_YAML = `active: custom
profiles:
  custom:
    mode: remote-ensemble
    api: openrouter-remote
    free_only: true
    free_models: []
    model: whatever/does-not-matter
    api_key: "$OPENROUTER_API_KEY"
`;

/** A synthetic model-events timestamp, `msAgo` before "now", in the
 *  `YYYY-MM-DDTHH:MM:SS±HHMM` shape model-events.ts's parser expects. */
function isoTs(msAgo: number): string {
  const d = new Date(Date.now() - msAgo);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+0000`;
}

let cfgDir: string | undefined;
let prevCfgDir: string | undefined;
let prevDisableFreePoolBench: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  // Booting a 'free_only' profile ALSO fires the pre-existing, unrelated
  // free-pool-auto-bench.ts side effect (a REAL detached spawn against the
  // REAL $HOME config dir, not this test's tmp dir — it reads getConfigDir()
  // at its own call time, before LLM_EXT_CONFIG_DIR-scoped mocking would
  // matter). Opt it out so these hermetic wiring tests never shell out to a
  // real child process or touch the developer's actual ~/.llm-externalizer.
  prevDisableFreePoolBench = process.env.LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH;
  process.env.LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH = "1";
  populateDefaultProfileMock.mockReset();
  populateDefaultProfileMock.mockImplementation(
    (opts: { profile: string; allowPaidModels: boolean }): PopulationOutcome =>
      opts.profile === "paid-ensemble" || opts.profile === "paid-mass-scout"
        ? opts.allowPaidModels
          ? {
              kind: "spawned",
              profile: opts.profile as "paid-ensemble",
              pid: 4242,
              blocksCaller: true,
              logPath: "/tmp/llm-ext-test/default-profile-paid-ensemble.log",
            }
          : {
              kind: "refused",
              profile: opts.profile as "paid-ensemble",
              reason: `'${opts.profile}' has not been benchmarked yet, and benchmarking it sends billable requests while allow_paid_models is false`,
              remedy: `llm-ext-benchmark --populate-default-profile ${opts.profile} --budget-usd 2`,
            }
        : {
            kind: "spawned",
            profile: "free",
            pid: 4242,
            blocksCaller: false,
            logPath: "/tmp/llm-ext-test/default-profile-free.log",
          },
  );
  getProfileRecordMock.mockReset();
  getProfileRecordMock.mockReturnValue(undefined);
  readModelEventsMock.mockReset();
  readModelEventsMock.mockReturnValue([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (prevDisableFreePoolBench === undefined) delete process.env.LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH;
  else process.env.LLM_EXT_DISABLE_FREE_POOL_AUTO_BENCH = prevDisableFreePoolBench;
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  cfgDir = undefined;
  vi.unstubAllGlobals();
});

/** Write `settingsYaml` to a fresh temp config dir, point LLM_EXT_CONFIG_DIR
 *  at it, reset the module registry, and freshly re-import index.ts — so its
 *  module-load boot IIFE runs against exactly this settings.yaml. */
async function loadFreshIndex(settingsYaml: string) {
  // config.ts's getConfigDir() only allows paths under $HOME or /private/tmp
  // (a hardening guard) — mirror config.test.ts's pattern (mkdtempSync under
  // "/tmp", which resolves to /private/tmp on macOS), never os.tmpdir().
  cfgDir = mkdtempSync(join("/tmp", "llm-ext-default-profile-wiring-"));
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  return import("./index.js");
}

// ── Task 1: the boot gate ────────────────────────────────────────────────

describe("boot gate — unpopulated default profiles boot instead of NOT CONFIGURED", () => {
  it("a fresh install with an unpopulated 'free' default profile boots (settingsValid, activeResolved)", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_FREE_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("a fresh install with an unpopulated 'paid-ensemble' default profile boots", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_PAID_ENSEMBLE_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: true, activeResolved: true });
  });

  it("a genuinely misconfigured user (non-default) profile still fails boot", async () => {
    const mod = await loadFreshIndex(MISCONFIGURED_CUSTOM_YAML);
    expect(mod.__getBootStateForTests()).toEqual({ settingsValid: false, activeResolved: false });
  });

  it("shouldBootDespiteInvalidActiveProfile: true only for an unpopulated machine-owned default", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_FREE_YAML);
    expect(
      mod.shouldBootDespiteInvalidActiveProfile("free", {
        mode: "remote-ensemble",
        api: "openrouter-remote",
        free_only: true,
        free_models: [],
        model: "placeholder/unpopulated-default-profile",
        api_key: "$OPENROUTER_API_KEY",
      }),
    ).toBe(true);
    // Same shape, but NOT one of the 5 machine-owned names — a real user
    // misconfiguration (an empty free_models pool on a hand-authored profile
    // is always invalid, never self-healing).
    expect(
      mod.shouldBootDespiteInvalidActiveProfile("my-custom-profile", {
        mode: "remote-ensemble",
        api: "openrouter-remote",
        free_only: true,
        free_models: [],
        model: "placeholder/unpopulated-default-profile",
        api_key: "$OPENROUTER_API_KEY",
      }),
    ).toBe(false);
    expect(mod.shouldBootDespiteInvalidActiveProfile("free", undefined)).toBe(false);
  });
});

// ── Task 2/4: the dispatcher hook ────────────────────────────────────────

describe("dispatcher hook — RECONCILE_SKIP_TOOLS never triggers population", () => {
  it("get_settings (a skip-listed, always-exempt tool) never calls populateDefaultProfile", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_FREE_YAML);
    await mod.boot();
    await mod.dispatchCallTool("get_settings", {});
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });
});

describe("dispatcher hook — maybeEnsureDefaultProfileReady", () => {
  it("'free' never blocks: proceeds (returns null) and spawns without waiting", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_FREE_YAML);
    await mod.boot();
    const gate = await mod.maybeEnsureDefaultProfileReady();
    expect(gate).toBeNull();
    expect(populateDefaultProfileMock).toHaveBeenCalledTimes(1);
    expect(populateDefaultProfileMock.mock.calls[0][0]).toMatchObject({ profile: "free" });
  });

  it("'paid-ensemble' under allow_paid_models: false refuses fast with the remedy, spawns nothing else", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_PAID_ENSEMBLE_YAML);
    await mod.boot();
    const gate = await mod.maybeEnsureDefaultProfileReady();
    expect(gate).not.toBeNull();
    expect(gate?.isError).toBe(true);
    const text = gate?.content[0]?.text ?? "";
    expect(text).toMatch(/has not been benchmarked yet/);
    expect(text).toMatch(/--populate-default-profile paid-ensemble/);
    expect(populateDefaultProfileMock).toHaveBeenCalledTimes(1);
  });

  it("'paid-ensemble' under allow_paid_models: true spawns AND blocks this call — proceeding would send the unroutable placeholder to the provider", async () => {
    // This test previously asserted `gate === null` ("proceeds"), which encoded
    // a real defect: the profile still holds PLACEHOLDER_MODEL_ID at this
    // moment, so proceeding sent that sentinel to OpenRouter and surfaced a raw
    // 404. `blocksCaller` existed to prevent exactly that and was never acted
    // on. The population still starts — only the current call is stopped, with
    // a message that says what to do.
    const mod = await loadFreshIndex(UNPOPULATED_PAID_ENSEMBLE_ALLOW_PAID_YAML);
    await mod.boot();
    const gate = await mod.maybeEnsureDefaultProfileReady();
    expect(populateDefaultProfileMock).toHaveBeenCalledTimes(1);
    expect(gate).not.toBeNull();
    expect(gate?.isError).toBe(true);
    expect(gate?.content?.[0]?.text).toMatch(/BENCHMARK IN PROGRESS/);
    expect(gate?.content?.[0]?.text).toMatch(/paid-ensemble/);
  });

  it("a live cooldown suppresses the attempt (no populateDefaultProfile call) on an unpopulated profile", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_FREE_YAML);
    await mod.boot();
    getProfileRecordMock.mockReturnValue({
      lastBenchmarkAt: 0,
      poolFingerprint: "",
      modelIds: [],
      failCount: 1,
      cooldownUntil: Date.now() + 60_000, // still in the future
    });
    const gate = await mod.maybeEnsureDefaultProfileReady();
    expect(gate).toBeNull(); // suppressed attempt still proceeds the tool call
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });

  it("an EMPTY catalog (fetch failure) never falsely invalidates an already-populated profile", async () => {
    const mod = await loadFreshIndex(POPULATED_MASS_SCOUT_YAML("some/still-configured-model"));
    await mod.boot();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const gate = await mod.maybeEnsureDefaultProfileReady();
    expect(gate).toBeNull();
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();
  });

  it("a transient 429 does NOT trigger population; 3 consecutive 404s within 24h does", async () => {
    const modelId = "flaky/model";
    const modA = await loadFreshIndex(POPULATED_MASS_SCOUT_YAML(modelId));
    await modA.boot();
    readModelEventsMock.mockReturnValue([
      { timestamp: isoTs(60_000), model: modelId, kind: "rate_limit_429", detail: "HTTP 429" },
    ]);
    const gateA = await modA.maybeEnsureDefaultProfileReady();
    expect(gateA).toBeNull();
    expect(populateDefaultProfileMock).not.toHaveBeenCalled();

    const modB = await loadFreshIndex(POPULATED_MASS_SCOUT_YAML(modelId));
    await modB.boot();
    readModelEventsMock.mockReturnValue([
      { timestamp: isoTs(3 * 3_600_000), model: modelId, kind: "non_retryable_failure", detail: "HTTP 404" },
      { timestamp: isoTs(2 * 3_600_000), model: modelId, kind: "non_retryable_failure", detail: "HTTP 404" },
      { timestamp: isoTs(1 * 3_600_000), model: modelId, kind: "non_retryable_failure", detail: "HTTP 404" },
    ]);
    const gateB = await modB.maybeEnsureDefaultProfileReady();
    // paid-mass-scout is PAID and allow_paid_models is true here, so population
    // starts AND this call is blocked — its configured model was just judged
    // persistently dead, so proceeding would re-send the very id that is gone.
    // The trigger invariant this test exists for is the call-count pair below;
    // only the return SHAPE changed.
    expect(gateB?.isError).toBe(true);
    expect(populateDefaultProfileMock).toHaveBeenCalledTimes(1);
    expect(populateDefaultProfileMock.mock.calls[0][0]).toMatchObject({ profile: "paid-mass-scout" });
  });
});
