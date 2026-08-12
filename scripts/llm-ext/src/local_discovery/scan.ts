/**
 * Local LLM service autodiscovery — the `scan_local_llm_services` tool's core.
 *
 * Pure(ish) logic, network-injectable, so it is unit-testable without a real
 * server running. Probes the well-known local OpenAI-compatible ports plus
 * Ollama's native API, with a short timeout so an absent service is fast and
 * silent rather than an error. `discoverLocalLlmServices` NEVER throws — a
 * probe failure (connection refused, timeout, malformed JSON) just becomes
 * `reachable: false` for that one entry.
 */

import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";

export type ServiceKind =
  | "lmstudio"
  | "ollama"
  | "vllm"
  | "llamacpp"
  | "openai-compatible";

export interface DiscoveredModel {
  id: string;
  /** Context length in tokens, when the server's response advertises one. */
  contextLength?: number;
}

export interface DiscoveredService {
  /** 1-based position in the scan list — what the user types with `--pick`. */
  index: number;
  kind: ServiceKind;
  baseUrl: string;
  reachable: boolean;
  models: DiscoveredModel[];
  /** The config.ts API_PRESETS key this service maps to. */
  presetName: string;
  /** Set when reachable is false — connection error or non-2xx status. */
  error?: string;
}

export interface CliEvidence {
  cli: string;
  installed: boolean;
}

export interface SystemInfo {
  totalRamBytes: number;
  cpuCount: number;
}

interface ProbeTarget {
  kind: ServiceKind;
  baseUrl: string;
  presetName: string;
  protocol: "openai" | "ollama";
}

/**
 * Well-known local LLM server ports (TRDD owner spec). This is a fixed scan
 * list, not a preference order — every entry is probed in parallel and all
 * results are reported, reachable or not.
 */
export const PROBE_TARGETS: readonly ProbeTarget[] = [
  { kind: "lmstudio", baseUrl: "http://localhost:1234", presetName: "lmstudio-local", protocol: "openai" },
  { kind: "vllm", baseUrl: "http://localhost:8000", presetName: "vllm-local", protocol: "openai" },
  { kind: "llamacpp", baseUrl: "http://localhost:8080", presetName: "llamacpp-local", protocol: "openai" },
  // Jan and other OpenAI-compatible local servers commonly default here.
  { kind: "openai-compatible", baseUrl: "http://localhost:1337", presetName: "generic-local", protocol: "openai" },
  { kind: "openai-compatible", baseUrl: "http://localhost:5000", presetName: "generic-local", protocol: "openai" },
  { kind: "openai-compatible", baseUrl: "http://localhost:8081", presetName: "generic-local", protocol: "openai" },
  // Ollama's OWN api, not the OpenAI-compat shim it also exposes — /api/tags
  // lists every locally pulled model, which /v1/models does not.
  { kind: "ollama", baseUrl: "http://localhost:11434", presetName: "ollama-local", protocol: "ollama" },
];

/** Short on purpose: an absent local service must be fast and silent, never
 * stall the scan waiting on a port nobody is listening on. */
const PROBE_TIMEOUT_MS = 2000;

/** The subset of the `fetch` signature this module needs — real `fetch` in
 * production, an injected stub in tests (no real network in unit tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

function parseOpenAiModels(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string") continue;
    const ctxRaw = rec.context_length ?? rec.max_context_length;
    out.push(typeof ctxRaw === "number" ? { id: rec.id, contextLength: ctxRaw } : { id: rec.id });
  }
  return out;
}

function parseOllamaTags(body: unknown): DiscoveredModel[] {
  if (!body || typeof body !== "object") return [];
  const models = (body as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const out: DiscoveredModel[] = [];
  for (const item of models) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = rec.name ?? rec.model;
    if (typeof name === "string") out.push({ id: name });
  }
  return out;
}

async function probeOne(target: ProbeTarget, fetchImpl: FetchLike): Promise<Omit<DiscoveredService, "index">> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const path = target.protocol === "ollama" ? "/api/tags" : "/v1/models";
  const base = { kind: target.kind, baseUrl: target.baseUrl, presetName: target.presetName };
  try {
    const res = await fetchImpl(`${target.baseUrl}${path}`, { signal: controller.signal });
    if (!res.ok) {
      return { ...base, reachable: false, models: [], error: `HTTP ${res.status}` };
    }
    const body: unknown = await res.json();
    const models = target.protocol === "ollama" ? parseOllamaTags(body) : parseOpenAiModels(body);
    return { ...base, reachable: true, models };
  } catch (err) {
    // Connection refused / timeout / not-JSON — all fold into "not reachable".
    // An absent local service is the overwhelmingly common case, not an error.
    return { ...base, reachable: false, models: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every well-known local endpoint in parallel. Never throws. */
export async function discoverLocalLlmServices(
  fetchImpl: FetchLike = fetch,
): Promise<DiscoveredService[]> {
  const results = await Promise.all(PROBE_TARGETS.map((t) => probeOne(t, fetchImpl)));
  return results.map((r, i) => ({ ...r, index: i + 1 }));
}

const KNOWN_LOCAL_CLIS = ["lms", "ollama"] as const;

function defaultCheckInstalled(cmd: string): boolean {
  try {
    if (process.platform === "win32") {
      execFileSync("where", [cmd], { stdio: "ignore" });
    } else {
      // `command -v` is a shell builtin, not a standalone binary, so it must
      // run through a shell. `cmd` only ever comes from KNOWN_LOCAL_CLIS
      // (never user input), so there is no injection surface here.
      execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Installed-but-possibly-stopped CLI evidence (owner spec: "note installed
 * CLIs as evidence a service exists but is stopped"). Best-effort — any PATH
 * lookup failure just reports `installed: false`, never throws.
 */
export function detectInstalledClis(
  checkInstalled: (cmd: string) => boolean = defaultCheckInstalled,
): CliEvidence[] {
  return KNOWN_LOCAL_CLIS.map((cli) => ({ cli, installed: checkInstalled(cli) }));
}

/** RAM + CPU count, for the "detect the best configuration for this system"
 * part of the report. Purely informational (see buildProfileForService's own
 * comment for why the profile itself is built only from what the service's
 * API actually reports, not from guessed RAM/CPU heuristics). */
export function detectSystemInfo(): SystemInfo {
  return { totalRamBytes: totalmem(), cpuCount: cpus().length };
}

/** Render the numbered scan list + CLI evidence exactly as shown to the user. */
export function formatDiscoveredServices(
  services: readonly DiscoveredService[],
  cliEvidence: readonly CliEvidence[],
): string {
  const lines: string[] = ["Local LLM services scan:"];
  for (const s of services) {
    if (s.reachable) {
      const modelList = s.models.length > 0 ? s.models.map((m) => m.id).join(", ") : "(no models loaded)";
      lines.push(`  ${s.index}. [${s.kind}] ${s.baseUrl} — REACHABLE — models: ${modelList}`);
    } else {
      lines.push(`  ${s.index}. [${s.kind}] ${s.baseUrl} — not reachable`);
    }
  }
  const installed = cliEvidence.filter((c) => c.installed);
  if (installed.length > 0) {
    lines.push("");
    lines.push(
      `Installed CLI(s) detected (may just be stopped): ${installed.map((c) => c.cli).join(", ")}`,
    );
  }
  return lines.join("\n");
}

export interface BuiltProfile {
  profileName: string;
  profile: Record<string, unknown>;
}

/**
 * Build a settings.yaml profile section for a REACHABLE, picked service.
 *
 * Deliberately builds the profile ONLY from what the service's own API
 * reported (model id, and context length when advertised) plus the fixed
 * local preset for its kind — never from a guessed RAM/CPU heuristic. A
 * fabricated "best" model or context window would be a worse default than an
 * honest one taken straight from the server, and `context_window: 0` (the
 * -local preset default) already means "auto-detect" everywhere else in this
 * codebase, so omitting it here is consistent, not a shortcut.
 *
 * Picks the FIRST model the server lists as the default — for LM Studio (only
 * the currently-loaded model is listed) that IS the obvious choice; for
 * Ollama/vLLM (every pulled/served model is listed) it's a deterministic,
 * good-enough default the user can hand-edit afterwards.
 */
export function buildProfileForService(
  service: DiscoveredService,
  existingProfileNames: readonly string[],
): BuiltProfile {
  if (!service.reachable) {
    throw new Error(`buildProfileForService: '${service.baseUrl}' is not reachable`);
  }
  const model = service.models[0]?.id;
  if (!model) {
    throw new Error(
      `buildProfileForService: '${service.baseUrl}' reported no models — load a model in the service first`,
    );
  }
  const baseName = `${service.kind}-local-auto`;
  let profileName = baseName;
  let n = 2;
  while (existingProfileNames.includes(profileName)) {
    profileName = `${baseName}-${n}`;
    n += 1;
  }
  const profile: Record<string, unknown> = {
    mode: "local",
    api: service.presetName,
    model,
    url: service.baseUrl,
  };
  const contextLength = service.models[0]?.contextLength;
  if (typeof contextLength === "number" && contextLength > 0) {
    profile.context_window = contextLength;
  }
  return { profileName, profile };
}
