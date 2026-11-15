/**
 * classifiers/l2/local-decider.ts — the LOCAL source of the local decider fallback (mlx-decision): find the ONE
 * system-wide mlx-decision singleton server and adopt it, or say precisely why it cannot be used.
 *
 * WHO CALLS IT: classifiers/l2/local-fallback.ts calls ensureLocalDecider before every local decision and then
 * sends the request through classifiers/l0/local-transport.ts.
 *
 * Hard rules, each a stated constraint rather than a preference:
 * - llm-ext NEVER starts an mlx-decision server. USER, 2026-11-13, verbatim: "yes, the mlx-decision was moved to
 *   be a startup singleton server process for all, to avoid the risk of duplicate processes." The singleton is
 *   started by the user (a login agent or by hand); this module only DISCOVERS and ADOPTS it, or refuses. Nothing here can
 *   cause a second server, so every "not there yet" answer is safe to retry.
 * - a decider is a /health answer with a 2xx status AND a JSON body with a `loaded` array. Anything else (a 404,
 *   a non-JSON page, a JSON body without `loaded`) is some other program on the port, never a decider.
 * - a decider that is up but has nothing loaded yet is WAITED for (the body, never the HTTP status, decides
 *   readiness: the server answers 200 before the model is loaded, with `loaded: []`).
 * - the refusals say whether waiting can heal them (`retryable`): a silent or still-loading server or a missing
 *   singleton may appear later, a wrong model or a non-macOS platform never will.
 * - step (a), probing the configured url, is PLATFORM-AGNOSTIC: a decider that answers there is adopted on any
 *   OS (for example a decider on a remote-forwarded loopback port). Only the process SCAN of step (b) is
 *   macOS-only, because it looks for an Apple-silicon MLX server.
 * - this is a fallback, so ensureLocalDecider never throws: a fallback that throws would fail the command it
 *   exists to help.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { safeReadText } from "../../safe-body.js";
import { createDeadline } from "../l0/deadline.js";
import { MAX_REPLY_BYTES, type GlobalFetch } from "../l0/transport.js";
import { discoverDeciders, type DiscoveredDecider } from "./local-discovery.js";

/** The one model this increment serves. WHY a constant, not a settings key: `local_fallback` names no model
 * (config.ts LOCAL_FALLBACK_KEYS), because the model is the identity of the decider itself, and adoption has to be able
 * to say whether the server it found is the right one. A configurable served model is a later increment. */
export const SERVED_MODEL = "elephant-1";

/** The local decider settings of the `local_fallback` section (settings.yaml), already checked by
 * config.ts localFallbackErrors. */
export interface LocalDeciderConfig {
  enabled: boolean;
  /** e.g. http://127.0.0.1:8123 — loopback only (config.ts refuses anything else). The first place looked at. */
  url: string;
  /** How long to wait for an ADOPTED singleton to finish loading its model (ms). The effective wait is min(startTimeoutMs, the remaining request budget): the outer deadline cuts it, so a startTimeoutMs above requestTimeoutMs is harmless. */
  startTimeoutMs: number;
  /** Per-attempt timeout for the local POST (ms). Each retry gets this budget. */
  attemptTimeoutMs: number;
  /** Overall deadline for the whole escalation, lookups and POST retries alike (ms). */
  requestTimeoutMs: number;
  /** Max local POST attempts (1..100). Lookups for a not-ready singleton do not count: the outer deadline bounds those. */
  maxAttempts: number;
}

/**
 * Re-exported from config.ts, where the one implementation lives: config.ts must not import from
 * classifiers/ (the cycle rule stated at config.ts:202), so the ONE implementation is there and the local
 * decider names it here for the callers of this module.
 */
export { localFallbackErrors } from "../../config.js";

/** What ensureLocalDecider answers. `retryable` is true only when time can change the answer (the singleton is
 * restarting, loading, or busy); false for a verdict that cannot heal (wrong model, wrong platform, not installed).
 * `aborted` marks a lookup the caller cut short (Ctrl-C, or the outer request deadline): not a verdict about the
 * singleton. `detail` then says what was being waited for, so the final message can name it instead of "aborted". */
export type LocalDeciderResult =
  | { ok: true; baseUrl: string }
  | { ok: false; reason: string; retryable: boolean; aborted?: true; detail?: string };

/** The seams. Every one except fetch and now defaults to production, so a test proves a decision without
 * depending on what happens to be running on, or installed on, the machine that runs it. */
export interface LocalDeciderDeps {
  fetch: GlobalFetch;
  now: () => number;
  /** Ends the wait at once (Ctrl-C, --command_timeout, the outer request deadline): an aborted wait must not keep polling. */
  signal?: AbortSignal;
  /** The process scan. Production uses local-discovery.ts. */
  discover?: () => Promise<DiscoveredDecider[]>;
  /** The platform the decider can run on is checked against this. Production: process.platform. */
  platform?: NodeJS.Platform;
  /** Whether a singleton can appear on this machine (binary on PATH or a login agent). Production: singletonInstalledOnDisk. */
  singletonInstalled?: () => boolean;
}

/** The /health timeout of one probe: a decider that does not answer at once is not ready, and the poll (not
 * this timeout) is what waits for a load. */
const HEALTH_TIMEOUT_MS = 2000;
/** The poll interval of the wait for a loading singleton. */
export const POLL_INTERVAL_MS = 500;

/** The one aborted verdict. Not retryable: the caller asked to stop. */
const ABORTED: LocalDeciderResult = { ok: false, reason: "the local decider lookup was aborted", retryable: false, aborted: true };

/** One /health probe, three-way. WHY three states and not a boolean: "nothing answered" (connection refused)
 * and "something answered that is not a decider" (a 404, another program) lead to the same next step, but only
 * the first can be a singleton that is still starting, and the reasons shown to the user differ. */
type Health = { kind: "decider"; loaded: string[] } | { kind: "not-decider" } | { kind: "unreachable" };

/**
 * Ask /health once. A decider is ONLY a 2xx answer whose body is JSON with a `loaded` array: the status alone
 * (any web server answers 200) and a JSON body alone (an error page can be JSON) each prove nothing, so a port
 * held by another program is never mistaken for the decider and never waited on.
 * WHY createDeadline and not AbortSignal.timeout + AbortSignal.any: a platform AbortSignal.timeout timer is not
 * cleared when the probe ends, and the poll loop makes many probes, so each would leave a live timer behind;
 * createDeadline timers are cleared by dispose() in the finally.
 */
async function probeHealth(fetchImpl: GlobalFetch, url: string, callerSignal?: AbortSignal): Promise<Health> {
  const deadline = createDeadline({ timeoutMs: HEALTH_TIMEOUT_MS, signal: callerSignal });
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", redirect: "error", signal: deadline.signal });
    } catch {
      return { kind: "unreachable" };
    }
    if (!res.ok) return { kind: "not-decider" };
    try {
      const data = JSON.parse(await safeReadText(res, MAX_REPLY_BYTES)) as { loaded?: unknown };
      if (!Array.isArray(data.loaded)) return { kind: "not-decider" };
      return { kind: "decider", loaded: data.loaded.filter((m): m is string => typeof m === "string") };
    } catch {
      // A body that is not JSON (or not readable) is some other program, never a load we claim.
      return { kind: "not-decider" };
    }
  } finally {
    deadline.dispose();
  }
}

/** A wait that ends at once on the caller signal, so an abort never sits out the poll interval. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** The /health url of a configured base url (a trailing slash would double it). */
function healthUrl(url: string): string {
  return `${url.replace(/\/+$/, "")}/health`;
}

/** A path that exists AND is a regular file. WHY not existsSync: a directory named mlx-decision on PATH is not a binary. Only "no such entry" is false; any other error is an unknown and propagates. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

/**
 * Whether a singleton can appear under `home` and `pathEnv`: the mlx-decision binary is a regular file in a PATH
 * directory, or a LaunchAgent plist whose name contains mlx-decision exists. WHY either: the agent is what starts
 * the singleton at login, and the binary is what the agent runs; a machine with neither will never have a server,
 * so waiting for one would only stall. WHY only `.plist` names: a backup such as `mlx-decision.plist.bak` is never
 * loaded by launchd, so it must not make a missing install look installed. Parameters instead of process globals
 * so a test can point it at a temp HOME and PATH.
 */
export function singletonInstalledAt(home: string, pathEnv: string): boolean {
  if (pathEnv.split(delimiter).some((dir) => dir !== "" && isRegularFile(join(dir, "mlx-decision")))) return true;
  try {
    return readdirSync(join(home, "Library", "LaunchAgents")).some((name) => name.includes("mlx-decision") && name.endsWith(".plist"));
  } catch (e) {
    // WHY only ENOENT is "not installed": a directory that exists but cannot be read is an unknown, and the
    // caller turns a throw into a refusal that says so instead of claiming nothing is installed.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Production answer to "can a singleton appear here": singletonInstalledAt with the real HOME and PATH. */
function singletonInstalledOnDisk(): boolean {
  return singletonInstalledAt(homedir(), process.env.PATH ?? "");
}

/**
 * Decide what to do with a server that answered /health AS A DECIDER: adopt it, wait for its model, or refuse.
 * WHY adopt only a MATCHING model: that server serves whatever model it was given, and sending this run state
 * to another model answers the user question with the wrong model judgement.
 */
async function adoptDecider(cfg: LocalDeciderConfig, deps: LocalDeciderDeps, url: string, loaded: string[]): Promise<LocalDeciderResult> {
  if (loaded.includes(SERVED_MODEL)) return { ok: true, baseUrl: url };
  if (loaded.length === 0) {
    const waited = await waitForLoaded(cfg, deps, url);
    if (waited === null) {
      return { ok: false, retryable: true, reason: `the mlx-decision server on ${url} is still loading its model after ${cfg.startTimeoutMs} ms: llm-ext never starts or replaces it` };
    }
    if (waited.ok) return waited;
    // WHY the detail: the wait was cut by the caller signal (Ctrl-C or the outer request deadline). "Aborted" says
    // nothing a user can act on, while "still loading" tells them the singleton was up and just slow.
    return { ...waited, detail: `the mlx-decision server on ${url} was still loading its model when the lookup ended; llm-ext never starts or replaces it` };
  }
  return { ok: false, retryable: false, reason: `the mlx-decision server on ${url} serves ${loaded.join(", ")}, not ${SERVED_MODEL}: the singleton must serve ${SERVED_MODEL}; llm-ext never starts or replaces it, so this run cannot use it` };
}

/**
 * Find the mlx-decision singleton and return the base url to SEND to, or refuse with a reason. NEVER throws.
 *
 * ADOPT-ONLY (USER, 2026-11-13, verbatim): "yes, the mlx-decision was moved to be a startup singleton server
 * process for all, to avoid the risk of duplicate processes." There is no start path here at all, so no verdict
 * of this function can produce a second 15 GB server; "not found yet" is therefore always safe to retry.
 *
 * The order is: (a) the configured url answers as a decider -> adopt/wait/refuse on it; (b) otherwise, on macOS
 * only, scan the process table for a running mlx-decision server (matched by its argv; the url it serves on is
 * read from the sockets that process listens on, since argv names only the port it was asked for) and treat each
 * url the same way; (c) nothing found anywhere: say whether
 * a singleton can still appear (installed -> retryable) or never will (not installed -> not retryable).
 *
 * Returns the base url the caller must SEND to, which is not always cfg.url: the singleton keeps whatever port
 * it bound.
 */
export async function ensureLocalDecider(cfg: LocalDeciderConfig, deps: LocalDeciderDeps): Promise<LocalDeciderResult> {
  // WHY first: a lookup already cancelled must not probe anything.
  if (deps.signal?.aborted) return ABORTED;

  // (a) the configured url first: the cheapest probe. Only a real decider answer counts; anything else here
  // (404, another program, nothing) means "no decider at cfg.url" and the scan below looks elsewhere.
  const own = await probeHealth(deps.fetch, healthUrl(cfg.url), deps.signal);
  // WHY re-checked after every probe: an aborted probe is indistinguishable from an unreachable port (both throw).
  if (deps.signal?.aborted) return ABORTED;
  if (own.kind === "decider") return adoptDecider(cfg, deps, cfg.url, own.loaded);

  // (b) platform precheck BEFORE the scan: the decider is an MLX server and runs only on Apple silicon, so a
  // scan elsewhere could never find one and a retry could never heal it.
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { ok: false, retryable: false, reason: "the local mlx-decision decider runs only on macOS (Apple silicon)" };
  }
  let running: DiscoveredDecider[];
  try {
    running = await (deps.discover ?? discoverDeciders)();
  } catch (e) {
    // WHY retryable: "could not look" (ps or lsof failed) is transient, and since nothing is ever started here it cannot cause a second server.
    return { ok: false, retryable: true, reason: `cannot list running mlx-decision servers with ps and lsof (${(e as Error).message}); llm-ext never starts one` };
  }
  if (deps.signal?.aborted) return ABORTED;

  // WHY no `url !== cfg.url` filter: step (a) can fail on a /health that flaked under load while the scan finds a
  // process bound there; it is probed again and adopted or refused like any other discovered url.
  const urls = [...new Set(running.flatMap((d) => d.urls))];
  // WHY a separate refusal: a matched process with no listener reachable on 127.0.0.1 is still coming up, bound
  // elsewhere (IPv6-only, [::1] or a LAN address), or a phantom; it is not "no server"
  // (that reads as not running or not installed), it is retryable, and it names the pids because argv
  // alone cannot say which process is the phantom.
  if (urls.length === 0 && running.length > 0) {
    return {
      ok: false,
      retryable: true,
      reason: `an mlx-decision server process (pid ${running.map((d) => d.pid).join(", ")}) is running but has no listener llm-ext can reach on 127.0.0.1; llm-ext never starts or replaces it`,
    };
  }
  if (urls.length > 0) {
    // WHY a Python server bound to :: is IPv6-only: parseLsofListeners maps its tIPv6 *:P socket to 127.0.0.1, where it
    // will not answer, so it ends as the retryable "did not answer /health" below. That is expected; the mapping
    // does not make such a server reachable.
    // The first refusal is kept because the reasons name a url, and the caller prints one line.
    let refusal: LocalDeciderResult | null = null;
    for (const url of urls) {
      const health = await probeHealth(deps.fetch, healthUrl(url), deps.signal);
      if (deps.signal?.aborted) return ABORTED;
      if (health.kind === "decider") {
        const verdict = await adoptDecider(cfg, deps, url, health.loaded);
        if (verdict.ok) return verdict;
        // WHY returned at once on abort: the wait was cut by the caller, so trying the next server would only probe for a lookup nobody wants any more.
        if (deps.signal?.aborted) return verdict;
        refusal ??= verdict;
        continue;
      }
      // WHY a silent or non-decider answer from a process whose argv says mlx-decision is retryable: it is still
      // coming up, busy, or restarting, never absent.
      refusal ??= {
        ok: false,
        retryable: true,
        reason: health.kind === "unreachable"
          ? `an mlx-decision server is running on ${url} but did not answer /health; llm-ext never starts or replaces it`
          : `an mlx-decision server is running on ${url} but its /health did not answer as a decider (2xx with a loaded list); llm-ext never starts or replaces it`,
      };
    }
    // WHY never null here: urls is non-empty and every iteration either returns or sets refusal.
    return refusal ?? { ok: false, retryable: true, reason: "an mlx-decision server is running but none answered as a decider" };
  }

  // (c) nothing found anywhere: can a singleton still appear on this machine?
  let installed: boolean;
  try {
    installed = (deps.singletonInstalled ?? singletonInstalledOnDisk)();
  } catch (e) {
    return { ok: false, retryable: false, reason: `cannot check whether mlx-decision is installed: ${(e as Error).message}` };
  }
  if (installed) {
    return { ok: false, retryable: true, reason: "no mlx-decision server is running yet (the singleton may be restarting); llm-ext never starts one" };
  }
  return { ok: false, retryable: false, reason: "mlx-decision is not installed and no singleton server is running; llm-ext never starts one — install mlx-decision and start its server yourself (this plugin does not install or start it)" };
}

/**
 * Poll /health until a model is loaded, startTimeoutMs expires, or the caller aborts. `null` means "gave up
 * waiting"; a non-null value is the final verdict.
 * WHY a loop on the body: a 200 with nothing loaded is NORMAL while the singleton loads, never readiness.
 * WHY `>=` and not `>`: a startTimeoutMs of 0 (the fast-fail lookup of local-fallback.ts) must give up at once
 * instead of sitting out one poll interval, since the caller already saw this server answer with nothing loaded.
 */
async function waitForLoaded(cfg: LocalDeciderConfig, deps: LocalDeciderDeps, url: string): Promise<LocalDeciderResult | null> {
  const deadline = deps.now() + cfg.startTimeoutMs;
  for (;;) {
    if (deps.signal?.aborted) return ABORTED;
    if (deps.now() >= deadline) return null;
    const health = await probeHealth(deps.fetch, healthUrl(url), deps.signal);
    if (health.kind === "decider" && health.loaded.includes(SERVED_MODEL)) return { ok: true, baseUrl: url };
    await sleepAbortable(POLL_INTERVAL_MS, deps.signal);
  }
}
