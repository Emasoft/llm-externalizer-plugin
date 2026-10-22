/**
 * Wiring tests for Phase 4 of the dynamic default profiles (TRDD plan
 * "robust-giggling-dusk"): the boot gate (index.ts's IIFE around
 * validateSettings) and the dispatcher hook (dispatchCallToolInner, beside
 * runModelReconcile()) that together make the machine-owned dynamic profiles
 * ('free' | 'paid') boot and maintain instead of sitting inert.
 *
 * P6c-a item 5: the `maybeEnsureDefaultProfileReady` half of this file is GONE
 * with the lazy-population arm it tested — the dynamic maintainer
 * (dynamic-maintainer.test.ts) is now the only maintenance path, and the boot
 * gate below is what still has to hold.
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

const UNPOPULATED_PAID_YAML = `active: paid
allow_paid_models: false
profiles:
  paid:
    mode: remote
    api: openrouter-remote
    model: placeholder/unpopulated-default-profile
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

let cfgDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
  // free-pool-auto-bench.ts retired (P6b item 6, TRDD-90DM5YHO): booting a
  // 'free_only' profile used to ALSO fire its unconditional module-boot
  // spawn (a REAL detached child against the REAL $HOME config dir) —
  // removed at the source (index.ts's boot IIFE) rather than opted out of
  // here, so there is no longer a real side effect to suppress.
  populateDefaultProfileMock.mockReset();
  populateDefaultProfileMock.mockImplementation(
    (opts: { profile: string; allowPaidModels: boolean }): PopulationOutcome =>
      opts.profile === "paid"
        ? opts.allowPaidModels
          ? {
              kind: "spawned",
              profile: "paid",
              pid: 4242,
              blocksCaller: true,
              logPath: "/tmp/llm-ext-test/default-profile-paid.log",
            }
          : {
              kind: "refused",
              profile: "paid",
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

  it("a fresh install with an unpopulated 'paid' dynamic profile boots", async () => {
    const mod = await loadFreshIndex(UNPOPULATED_PAID_YAML);
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
    // Same shape, but NOT one of the two machine-owned names — a real user
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

