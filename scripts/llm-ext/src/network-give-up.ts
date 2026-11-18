// TRDD-PN0N4290 (increment 1b of TRDD-WSPV40Y5): the bounded give-up window for network-level remote failures, the STRICT provider
// probe it needs, and the no-process "is a local fallback target ready now" check. The window itself runs in provider/http.ts (it
// rides on the RetryClock); this module decides WHETHER it is armed and for how long. No process is spawned and nothing is
// downloaded or calibrated here: every check reads a file, the PATH or one HTTP answer.

import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { BrokerEngine } from "./broker/protocol.js";
import { snapshotWeightFiles, ggufShards } from "./calibration/fingerprint.js";
import { readRecordStatus } from "./calibration/record.js";
import { fallbackToLocalSetting, isDynamicProfileName, localsPlatformSupported, networkGiveUpErrors, type ResolvedProfile, type Settings } from "./config.js";
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

/**
 * Whether `files` (the names in a cached snapshot) hold the LLM weights llama-server -hf would load for `quant`, so that it never has to download.
 * Mirrors download.cpp find_best_model at llama.cpp commit 8642541b2 (the installed build): a file counts when it ends in .gguf, its basename is
 * neither a sidecar (mmproj, mtp-) nor an imatrix, and the quant matches as a token; a split model counts only when ALL its shards are cached,
 * because the plan takes every shard of the repo listing as a download task (download.cpp:842 get_split_files, arg.cpp:529-541 add_tasks).
 * WHY not the old name.includes(quant): an mmproj-X-Q8_0.gguf or mmproj-X-F16.gguf projector stood in for absent weights, and Q4_K matched Q4_K_M
 * and Q4_K_S, so an absent model read as ready and llama-server then downloaded it (TRDD-GNKO7WZS).
 * WHY the left boundary (^|[-_./]) is stricter than 8642541b2, whose regex is just `QUANT[.-]`: that build lets any text precede the quant (tag K_M
 * inside Q4_K_M, tag Q4_0 inside IQ4_0), llama.cpp master has since added a left boundary, and an unknown tag must never read as ready. The cost is
 * only a false "not ready" for a quant glued to a letter prefix, which leaves the local fallback unarmed (the safe side).
 */
function ggufQuantWeightsOnDisk(files: string[], quant: string): boolean {
  const names = new Set(files);
  const pattern = new RegExp(`(^|[-_./])${quant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[.-]`, "i");
  return files.some((f) => {
    const base = f.slice(f.lastIndexOf("/") + 1);
    // endsWith, not an /i regex: upstream gguf_filename_is_model uses the case-sensitive string_ends_with(".gguf"), so X.GGUF is no weight file for llama-server.
    if (!f.endsWith(".gguf") || base.includes("mmproj") || base.includes("mtp-") || base.includes("imatrix") || !pattern.test(f)) return false;
    const shard = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i.exec(f);
    if (shard === null || Number(shard[3]) <= 1) return true;
    if (Number(shard[2]) !== 1) return false;
    const count = Number(shard[3]);
    for (let i = 2; i <= count; i++) if (!names.has(`${shard[1]}-${String(i).padStart(5, "0")}-of-${shard[3]}${f.slice(-5)}`)) return false;
    return true;
  });
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
  return snap !== undefined && ggufQuantWeightsOnDisk(readdirSync(snap), quant);
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
  // TRDD-M4KERGEF F8: validation judges the pin on the same platform as the readiness check below, so a locals-local pin on a platform Locals cannot run on fails fast instead of silently never running.
  const setting = fallbackToLocalSetting(settings, o.platform, o.arch);
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

/** makeNetworkGiveUp options: the readiness environment plus an optional extra readiness check the caller owns. */
export interface GiveUpOptions extends ReadyNowEnv {
  /** Run by arm right after the readyLocalTarget check; false leaves the window unarmed. Throws are caught by arm (stderr line, unarmed). */
  sendReady?: () => boolean;
}

/**
 * TRDD-PN0N4290 + TRDD-WSPV40Y5: the ONE predicate of "a remote failure of this profile may finish on a local profile". WHY shared:
 * the give-up window (newNetworkGiveUp) and the fallback step (tryLocalFallback) both ask it, so they can never disagree. A
 * disagreement armed the window for a static user profile (retry budget cut to the window) while the fallback never ran after it.
 * Only the built-in remote dynamic profiles qualify (static user-defined profiles do NOT fall back: the 2026-09-17 ruling); a
 * local active profile has no remote to give up on, and `local` is dynamic by name but local by mode.
 */
export function remoteFallbackApplies(resolved: Pick<ResolvedProfile, "isLocal" | "mode"> | null, profileName: string): boolean {
  return resolved !== null && !resolved.isLocal && resolved.mode !== "local" && isDynamicProfileName(profileName);
}

/**
 * The give-up window of one dispatch. `arm` runs once, at the first isolation failure, and needs ALL THREE: (iii) a local target is
 * ready now (readyLocalTarget, plus the caller's sendReady: the local send also needs a calibrated sizing for the running tool, which
 * readiness alone does not vouch for, TRDD-WSPV40Y5 F2), (i) trigger (c) holds over the causes seen so far (the one failure that
 * started the run), (ii) the strict probe gives no genuine provider answer. WHY this order: cheapest first, so a user with no ready
 * local profile (the common case) does no network I/O at all and keeps the existing retries exactly as before, and the 5 s probe is
 * the last resort.
 * WHY arm catches: its promise is memoized by http.ts (giveUp.armed), so a throw (an unreadable cache dir or record, a model unfit
 * for the tool's sizing) would replace the real network error of every later failure with the fs error. A caught throw writes one
 * stderr line naming the cause and leaves the window unarmed, so the caller throws its ORIGINAL verdict (never silent).
 */
export function makeNetworkGiveUp(settings: Settings, configDir: string, o: GiveUpOptions = {}): NetworkGiveUp {
  return {
    windowMs: networkGiveUpMs(settings),
    arm: async (err, url) => {
      try {
        if (readyLocalTarget(settings, configDir, o) === undefined) return false;
        if (o.sendReady !== undefined && !o.sendReady()) return false;
        if (!isNetworkIsolation([freeFailureCause("request", err, failureText(err))])) return false;
        const base = probeBaseUrl(url);
        if (base === undefined) return false;
        return !(await strictProviderAnswer(base));
      } catch (armErr) {
        process.stderr.write(`[llm-externalizer] the network give-up window stays unarmed, the original network error is thrown: ${failureText(armErr).split("\n")[0].slice(0, 300)}\n`);
        return false;
      }
    },
  };
}
