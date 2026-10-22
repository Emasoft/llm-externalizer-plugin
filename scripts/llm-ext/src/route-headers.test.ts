/**
 * route-headers.test.ts — item 3/A2 (open-items-design 2026-09-16): index.ts's
 * `routeHeaders` (a routed model's own auth + attribution headers, so a b.ai
 * model never leaks the OpenRouter key or vice versa) was previously exercised
 * ONLY through a mock in provider/connection.test.ts — the real function's
 * empty-authToken branch and its protocol-gated HTTP-Referer/X-Title headers
 * had zero coverage. `__routeHeadersForTests` (index.ts, next to
 * `__getBootStateForTests`) exposes it directly.
 *
 * index.ts's boot IIFE runs at module-import time from whatever settings.yaml
 * + LLM_EXT_CONFIG_DIR are in effect — same recipe as
 * default-profile-wiring.test.ts's `loadFreshIndex`: write a fresh
 * settings.yaml, point LLM_EXT_CONFIG_DIR at it, vi.resetModules(), re-import.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedRoute } from "./config.js";

let cfgDir: string | undefined;
let prevCfgDir: string | undefined;

beforeEach(() => {
  prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
});

afterEach(() => {
  if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
  cfgDir = undefined;
});

// D0 fix-up (TRDD-AL8GIZYA): a STATIC profile, not `paid` — `http_referer`/
// `app_name` are not (yet) a DYNAMIC_GENERATED_KEYS/DYNAMIC_USER_OWNED_KEYS
// entry for any dynamic profile (design section 1.2: "not made user-owned,
// to keep this change minimal"), so E-D1 now refuses them on `paid` (see the
// dedicated E-D1 case below). This fixture's whole point is routeHeaders'
// header logic, which reads them off ANY validated profile — a static name
// with a real-looking model id boots with activeResolved set with no
// special-casing needed.
const STATIC_WITH_ATTRIBUTION_YAML = `active: my-attribution
allow_paid_models: true
profiles:
  my-attribution:
    mode: remote
    api: openrouter-remote
    model: vendor/model
    api_key: "sk-test-fake-openrouter-key"
    http_referer: https://example.test/referer
    app_name: ExampleApp
`;

/** Write `settingsYaml` to a fresh temp config dir, point LLM_EXT_CONFIG_DIR at
 *  it, reset the module registry, and freshly re-import index.ts — mirrors
 *  default-profile-wiring.test.ts's loadFreshIndex. */
async function loadFreshIndex(settingsYaml: string) {
  cfgDir = mkdtempSync(join("/tmp", "llm-ext-route-headers-"));
  writeFileSync(join(cfgDir, "settings.yaml"), settingsYaml, "utf-8");
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  vi.resetModules();
  return import("./index.js");
}

const OPENROUTER_ROUTE: ResolvedRoute = {
  name: "openrouter-remote",
  api: "openrouter-remote",
  protocol: "openrouter_api",
  url: "https://openrouter.ai/api",
  authToken: "route-key",
  keyRef: "none",
  isLocal: false,
  isFreeProvider: false,
  models: ["some/model"],
};

const OPENAI_COMPAT_ROUTE: ResolvedRoute = {
  ...OPENROUTER_ROUTE,
  api: "chat-b-ai-remote",
  protocol: "openai_api",
};

describe("__routeHeadersForTests — item 3/A2", () => {
  it("omits Authorization when route.authToken is empty", async () => {
    const mod = await loadFreshIndex(STATIC_WITH_ATTRIBUTION_YAML);
    const h = mod.__routeHeadersForTests({ ...OPENAI_COMPAT_ROUTE, authToken: "" });
    expect(h).not.toHaveProperty("Authorization");
  });

  it("adds Authorization: Bearer <token> when route.authToken is set", async () => {
    const mod = await loadFreshIndex(STATIC_WITH_ATTRIBUTION_YAML);
    const h = mod.__routeHeadersForTests({ ...OPENAI_COMPAT_ROUTE, authToken: "bai-key" });
    expect(h["Authorization"]).toBe("Bearer bai-key");
  });

  it("adds HTTP-Referer/X-Title for an openrouter_api route", async () => {
    const mod = await loadFreshIndex(STATIC_WITH_ATTRIBUTION_YAML);
    const h = mod.__routeHeadersForTests(OPENROUTER_ROUTE);
    expect(h["HTTP-Referer"]).toBe("https://example.test/referer");
    expect(h["X-Title"]).toBe("ExampleApp");
  });

  it("omits HTTP-Referer/X-Title for a non-openrouter_api route even when activeResolved has them", async () => {
    const mod = await loadFreshIndex(STATIC_WITH_ATTRIBUTION_YAML);
    const h = mod.__routeHeadersForTests(OPENAI_COMPAT_ROUTE);
    expect(h).not.toHaveProperty("HTTP-Referer");
    expect(h).not.toHaveProperty("X-Title");
  });
});

// D0 fix-up (TRDD-AL8GIZYA): the same http_referer/app_name keys are refused
// with E-D1 on a DYNAMIC profile (`paid`) — design section 1.2 keeps them out
// of DYNAMIC_GENERATED_KEYS/DYNAMIC_USER_OWNED_KEYS "to keep this change
// minimal". Direct validateProfile call, no boot: this asserts the ownership
// rule, not header rendering (already covered above).
describe("D0: http_referer/app_name stay refused on a dynamic profile", () => {
  it("E-D1 refuses http_referer and app_name on 'paid'", async () => {
    const { validateProfile } = await import("./config.js");
    const res = validateProfile("paid", {
      mode: "remote",
      api: "openrouter-remote",
      model: "vendor/model",
      api_key: "sk-test-fake-openrouter-key",
      http_referer: "https://example.test/referer",
      app_name: "ExampleApp",
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.includes("'http_referer' is not allowed in a generated profile"))).toBe(true);
    expect(res.errors.some((e) => e.includes("'app_name' is not allowed in a generated profile"))).toBe(true);
  });
});
