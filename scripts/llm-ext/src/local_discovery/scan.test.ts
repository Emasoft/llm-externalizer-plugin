/**
 * scan_local_llm_services (owner spec) — discovery parsing + the write path the
 * `scan_local_llm_services` tool case in index.ts calls verbatim
 * (discoverLocalLlmServices → buildProfileForService → addProfileToSettings).
 *
 * No real network: every fetch is an injected stub (FetchLike), matching the
 * seam discoverLocalLlmServices was built with. No real ~/.llm-externalizer
 * either: the write-path tests redirect via LLM_EXT_CONFIG_DIR to a per-test
 * tmp dir (same pattern as session_summary/driver.test.ts's beforeEach), so
 * they can never touch the developer's real config.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import {
  discoverLocalLlmServices,
  detectInstalledClis,
  formatDiscoveredServices,
  buildProfileForService,
  PROBE_TARGETS,
  type FetchLike,
} from "./scan.js";
import { getSettingsPath } from "../config.js";
import { addProfileToSettings } from "../benchmark/pick.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response;
}

// ── Discovery parsing (no network) ───────────────────────────────────────

describe("discoverLocalLlmServices", () => {
  it("parses an OpenAI-compatible /v1/models response", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === "http://localhost:1234/v1/models") {
        return jsonResponse({
          data: [{ id: "local/lmstudio-model", context_length: 32768 }],
        });
      }
      throw new Error("connection refused");
    };
    const services = await discoverLocalLlmServices(fetchImpl);
    const lmstudio = services.find((s) => s.kind === "lmstudio");
    expect(lmstudio?.reachable).toBe(true);
    expect(lmstudio?.models).toEqual([{ id: "local/lmstudio-model", contextLength: 32768 }]);
    expect(lmstudio?.index).toBe(1);
  });

  it("parses an Ollama /api/tags response", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === "http://localhost:11434/api/tags") {
        return jsonResponse({ models: [{ name: "qwen3:14b" }, { name: "llama3:8b" }] });
      }
      throw new Error("connection refused");
    };
    const services = await discoverLocalLlmServices(fetchImpl);
    const ollama = services.find((s) => s.kind === "ollama");
    expect(ollama?.reachable).toBe(true);
    expect(ollama?.models).toEqual([{ id: "qwen3:14b" }, { id: "llama3:8b" }]);
  });

  it("an unreachable port yields 'not reachable', not a thrown error", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const services = await discoverLocalLlmServices(fetchImpl);
    expect(services).toHaveLength(PROBE_TARGETS.length);
    for (const s of services) {
      expect(s.reachable).toBe(false);
      expect(s.models).toEqual([]);
      expect(s.error).toBeTruthy();
    }
  });

  it("a non-2xx status is also 'not reachable', not thrown", async () => {
    const fetchImpl: FetchLike = async () => errorResponse(500);
    const services = await discoverLocalLlmServices(fetchImpl);
    expect(services.every((s) => s.reachable === false)).toBe(true);
  });

  it("numbers entries 1-based in scan order", async () => {
    const services = await discoverLocalLlmServices(async () => {
      throw new Error("refused");
    });
    expect(services.map((s) => s.index)).toEqual(services.map((_, i) => i + 1));
  });
});

describe("detectInstalledClis", () => {
  it("reports installed/not-installed per the injected checker, never throws", () => {
    const evidence = detectInstalledClis((cmd) => cmd === "ollama");
    expect(evidence.find((e) => e.cli === "ollama")?.installed).toBe(true);
    expect(evidence.find((e) => e.cli === "lms")?.installed).toBe(false);
  });
});

describe("formatDiscoveredServices", () => {
  it("renders a numbered list with reachable models and unreachable entries", async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (url === "http://localhost:1234/v1/models") {
        return jsonResponse({ data: [{ id: "local/m" }] });
      }
      throw new Error("refused");
    };
    const services = await discoverLocalLlmServices(fetchImpl);
    const text = formatDiscoveredServices(services, []);
    expect(text).toMatch(/1\. \[lmstudio\] http:\/\/localhost:1234 — REACHABLE — models: local\/m/);
    expect(text).toMatch(/not reachable/);
  });
});

describe("buildProfileForService", () => {
  it("builds a local profile from the service's own reported model + context length", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url === "http://localhost:1234/v1/models"
        ? jsonResponse({ data: [{ id: "local/m", context_length: 16384 }] })
        : errorResponse(500);
    const services = await discoverLocalLlmServices(fetchImpl);
    const lmstudio = services.find((s) => s.kind === "lmstudio")!;
    const built = buildProfileForService(lmstudio, []);
    expect(built.profileName).toBe("lmstudio-local-auto");
    expect(built.profile).toEqual({
      mode: "local",
      api: "lmstudio-local",
      model: "local/m",
      url: "http://localhost:1234",
      context_window: 16384,
    });
  });

  it("avoids a name collision with an existing profile", async () => {
    const services = await discoverLocalLlmServices(async (url) =>
      url === "http://localhost:1234/v1/models" ? jsonResponse({ data: [{ id: "m" }] }) : errorResponse(500),
    );
    const lmstudio = services.find((s) => s.kind === "lmstudio")!;
    const built = buildProfileForService(lmstudio, ["lmstudio-local-auto"]);
    expect(built.profileName).toBe("lmstudio-local-auto-2");
  });

  it("refuses an unreachable service", async () => {
    const services = await discoverLocalLlmServices(async () => errorResponse(500));
    expect(() => buildProfileForService(services[0], [])).toThrow(/not reachable/);
  });

  it("refuses a reachable service that reports no models", async () => {
    const services = await discoverLocalLlmServices(async (url) =>
      url === "http://localhost:1234/v1/models" ? jsonResponse({ data: [] }) : errorResponse(500),
    );
    const lmstudio = services.find((s) => s.kind === "lmstudio")!;
    expect(() => buildProfileForService(lmstudio, [])).toThrow(/reported no models/);
  });
});

// ── Write path — the exact chain the tool case calls, against a tmp config dir ──

const BASE_SETTINGS = [
  "active: existing",
  "profiles:",
  "  existing:",
  "    mode: local",
  "    api: generic-local",
  "    model: existing-model",
  "    url: http://127.0.0.1:1",
  "    timeout: 5",
  "",
].join("\n");

describe("scan_local_llm_services write path (against LLM_EXT_CONFIG_DIR)", () => {
  let dir = "";
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
    dir = mkdtempSync(join("/tmp", "llm-ext-scan-local-cfg-"));
    process.env.LLM_EXT_CONFIG_DIR = dir;
    writeFileSync(join(dir, "settings.yaml"), BASE_SETTINGS, "utf-8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
  });

  it("default invocation (scan only, no pick) writes NOTHING to settings.yaml", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url === "http://localhost:1234/v1/models" ? jsonResponse({ data: [{ id: "m" }] }) : errorResponse(500);
    // Exactly what the tool case does when `pick` is absent: scan, format, return.
    // addProfileToSettings is never called on this path.
    await discoverLocalLlmServices(fetchImpl);
    expect(readFileSync(getSettingsPath(), "utf-8")).toBe(BASE_SETTINGS);
  });

  it("--pick N writes a new profile and sets it active, preserving the existing one", async () => {
    const fetchImpl: FetchLike = async (url) =>
      url === "http://localhost:1234/v1/models"
        ? jsonResponse({ data: [{ id: "local/picked-model", context_length: 8192 }] })
        : errorResponse(500);
    const services = await discoverLocalLlmServices(fetchImpl);
    const picked = services[0]; // index 1 == lmstudio (PROBE_TARGETS[0])
    expect(picked.kind).toBe("lmstudio");
    const built = buildProfileForService(picked, ["existing"]);

    const result = addProfileToSettings(getSettingsPath(), built.profileName, built.profile, {
      setActive: true,
    });

    expect(result).toEqual({ profileName: "lmstudio-local-auto", created: true, activated: true });
    const doc = yamlParse(readFileSync(getSettingsPath(), "utf-8")) as {
      active: string;
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(doc.active).toBe("lmstudio-local-auto");
    expect(doc.profiles.existing).toEqual({
      mode: "local",
      api: "generic-local",
      model: "existing-model",
      url: "http://127.0.0.1:1",
      timeout: 5,
    });
    expect(doc.profiles["lmstudio-local-auto"]).toEqual({
      mode: "local",
      api: "lmstudio-local",
      model: "local/picked-model",
      url: "http://localhost:1234",
      context_window: 8192,
    });
  });
});
