// TRDD-PN0N4290 (increment 1b of TRDD-WSPV40Y5): the bounded give-up window for network-level remote failures, the STRICT provider
// probe it needs, and the no-process "is a local fallback target ready now" check. The window itself runs in provider/http.ts (it
// rides on the RetryClock); this module decides WHETHER it is armed and for how long. No process is spawned and nothing is
// downloaded or calibrated here: every check reads a file, the PATH or one HTTP answer.

import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { BrokerEngine } from "./broker/protocol.js";
import { snapshotWeightFiles, ggufShards } from "./calibration/fingerprint.js";
import { readRecordStatus } from "./calibration/record.js";
import { fallbackToLocalSetting, localsPlatformSupported, networkGiveUpErrors, type Settings } from "./config.js";
import { freeFailureCause, isNetworkIsolation } from "./free-failure-cause.js";
import { localEngineOf } from "./local-input-budget.js";
import { hfCacheDir, parseManagedModel } from "./local-llama-server.js";
import { parseLocalsModel } from "./local-locals-server.js";
import { failureText, fetchWithTimeout, type NetworkGiveUp } from "./provider/http.js";

/**
 * The default window, seconds. WHY 30 (agent decision 2026-11-14 on TRDD-WSPV40Y5 Q10, under the owner instruction of that day):
 * no measured fact fixes the number, and a wrong early switch costs the whole command (the per-command latch), so it is longer than
 * the provisional 6 s: it covers a Wi-Fi reassociation and a DNS blip, and stays far below the 300 s remote retry deadline.
 */
export const DEFAULT_NETWORK_GIVE_UP_S = 30;

/** The reachability probe timeout, ms: the one bound of providerReachable (index.ts) and of the strict probe below. */
export const PROBE_TIMEOUT_MS = 5_000;

let flagOverrideS: number | undefined;

/** The --network_give_up flag of this command (cli/main.ts); it wins over the settings key. undefined clears it. */
export function setNetworkGiveUpOverrideS(seconds: number | undefined): void {
  flagOverrideS = seconds;
}

/** The window in ms: the flag, else settings.yaml network_give_up_seconds, else DEFAULT_NETWORK_GIVE_UP_S. A malformed key throws (fail fast; validateSettings reports it first at load). */
export function networkGiveUpMs(settings: Settings): number {
  if (flagOverrideS !== undefined) return flagOverrideS * 1000;
  const raw = settings.network_give_up_seconds;
  if (raw === undefined || raw === null) return DEFAULT_NETWORK_GIVE_UP_S * 1000;
  const errors = networkGiveUpErrors(raw);
  if (errors.length > 0) throw new Error(errors[0]);
  return (raw as number) * 1000;
}

/**
 * The STRICT probe (TRDD-PN0N4290): did the provider itself answer? GET `<baseUrl>/v1/models` with redirects NOT followed; ONLY
 * status 200 with a JSON body holding a `data` array counts. WHY not providerReachable (index.ts): it treats any status below 500
 * as up and follows redirects, so a captive portal answering 200 or 302 HTML reads as a live provider and would veto the
 * fallback. An HTML 2xx, any 3xx, any error status, a network error and a timeout are all "no genuine provider answer".
 */
export async function strictProviderAnswer(baseUrl: string): Promise<boolean> {
  let body: string;
  try {
    const res = await fetchWithTimeout(`${baseUrl}/v1/models`, { method: "GET", redirect: "manual" }, PROBE_TIMEOUT_MS);
    if (res.status !== 200) {
      await res.body?.cancel();
      return false;
    }
    body = await res.text();
  } catch {
    // Any network error or timeout of the probe itself is the answer: nothing genuine came back.
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { data?: unknown }).data);
  } catch {
    return false;
  }
}

/** The provider base URL of a failed chat request URL (`<base>/v1/chat/completions`), the base providerReachable is given too; undefined for any other shape (the probe is then not run and the window stays unarmed). */
export function probeBaseUrl(requestUrl: string): string | undefined {
  const suffix = "/v1/chat/completions";
  return requestUrl.endsWith(suffix) ? requestUrl.slice(0, -suffix.length) : undefined;
}

/** A local profile that can answer right now. */
export interface ReadyLocalTarget {
  profile: string;
  engine: BrokerEngine;
  model: string;
}

export interface ReadyNowEnv {
  platform?: string;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const exe = process.platform === "win32" ? `${command}.exe` : command;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    // A relative PATH entry would resolve against the cwd: never trusted (same rule as localsPython).
    if (!dir || !isAbsolute(dir)) continue;
    try {
      accessSync(join(dir, exe), constants.X_OK);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** The snapshot directory of a Hugging Face repo in a hub-layout cache, at the revision refs/main names; undefined when the repo is not cached. */
function cachedSnapshot(cacheDir: string, repo: string): string | undefined {
  const root = join(cacheDir, `models--${repo.replace(/\//g, "--")}`);
  const ref = join(root, "refs", "main");
  if (!existsSync(ref)) return undefined;
  const snap = join(root, "snapshots", readFileSync(ref, "utf8").trim());
  return existsSync(snap) ? snap : undefined;
}

/** Whether the weights of a managed llama.cpp model id are on disk (never downloads: that is llama-server -hf, which this module never runs). */
function llamaModelOnDisk(model: string, env: NodeJS.ProcessEnv): boolean {
  const parsed = parseManagedModel(model);
  if ("error" in parsed) return false;
  if (parsed.kind === "file") return ggufShards(model).every((f) => existsSync(f));
  // llama.cpp -hf and --hf-repo cache through hfCacheDir (LLAMA_CACHE first); NOT hubCacheDir, which ignores LLAMA_CACHE.
  if (parsed.kind === "hf-file") {
    const snap = cachedSnapshot(hfCacheDir(env), parsed.argv[1]);
    return snap !== undefined && existsSync(join(snap, parsed.argv[3]));
  }
  const [repo, quant] = model.split(":");
  const snap = cachedSnapshot(hfCacheDir(env), repo);
  return snap !== undefined && readdirSync(snap).some((f) => /\.gguf$/i.test(f) && f.toLowerCase().includes(quant.toLowerCase()));
}

/** Whether the MLX snapshot of a Locals model id is on disk. snapshotWeightFiles throws for a missing repo, which is the "not on disk" answer here. */
function localsModelOnDisk(model: string, env: NodeJS.ProcessEnv): boolean {
  if (!("ok" in parseLocalsModel(model))) return false;
  try {
    snapshotWeightFiles(model, env);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first local profile that can answer NOW (the section-4 ready-now checks of TRDD-WSPV40Y5): the engine binary is on PATH, the
 * HEAD model is on disk, and its calibration record is ok. Candidates in order: locals-mlx where this machine can run it, then
 * local_llama (agent decision B, section 3). Pure reads, no process: an unmanaged profile has no record and is never ready.
 * WHY the Locals check is PATH-only: localsPython also runs `uv tool dir`, a process; a `locals` installed only that way reads as
 * not ready here, which leaves the window unarmed (the existing retries), the safe side.
 * TRDD-M4KERGEF: settings.yaml `fallback_to_local` gates this. `enabled: false` returns undefined, so no fallback runs AND the 1b
 * window never arms (makeNetworkGiveUp asks this first). `profile` replaces the automatic list with that one profile: when it is
 * not ready the answer is undefined, never the automatic list (a pin is the user saying which model may load on this machine).
 * WHY gated here and not in the callers: the window and the fallback both ask this function, so one gate covers both.
 */
export function readyLocalTarget(settings: Settings, configDir: string, o: ReadyNowEnv = {}): ReadyLocalTarget | undefined {
  const env = o.env ?? process.env;
  const setting = fallbackToLocalSetting(settings);
  if (!setting.enabled) return undefined;
  const locals = localsPlatformSupported(o.platform, o.arch);
  const names = setting.profile !== undefined ? [setting.profile] : [...(locals ? ["locals-mlx"] : []), "local_llama"];
  for (const name of names) {
    const profile = settings.profiles[name];
    if (profile === undefined || profile.server !== "managed") continue;
    const engine = localEngineOf(profile.api);
    if (engine === null) continue;
    // TRDD-M4KERGEF: the platform gate is per ENGINE, so a pinned Locals profile is not tried where Locals cannot run; for the
    // automatic list it is the same gate as before (locals-mlx is the only locals-local candidate there).
    if (engine === "locals" && !locals) continue;
    const model = profile.model;
    const binary = engine === "llama" ? "llama-server" : "locals";
    if (!onPath(binary, env)) continue;
    if (!(engine === "llama" ? llamaModelOnDisk(model, env) : localsModelOnDisk(model, env))) continue;
    if (readRecordStatus(configDir, engine, model).state !== "ok") continue;
    return { profile: name, engine, model };
  }
  return undefined;
}

/**
 * The give-up window of one dispatch. `arm` runs once, at the first isolation failure, and needs ALL THREE: (iii) a local target is
 * ready now, (i) trigger (c) holds over the causes seen so far (the one failure that started the run), (ii) the strict probe gives
 * no genuine provider answer. WHY this order: cheapest first, so a user with no ready local profile (the common case) does no
 * network I/O at all and keeps the existing retries exactly as before, and the 5 s probe is the last resort.
 */
export function makeNetworkGiveUp(settings: Settings, configDir: string, o: ReadyNowEnv = {}): NetworkGiveUp {
  return {
    windowMs: networkGiveUpMs(settings),
    arm: async (err, url) => {
      if (readyLocalTarget(settings, configDir, o) === undefined) return false;
      if (!isNetworkIsolation([freeFailureCause("request", err, failureText(err))])) return false;
      const base = probeBaseUrl(url);
      if (base === undefined) return false;
      return !(await strictProviderAnswer(base));
    },
  };
}
