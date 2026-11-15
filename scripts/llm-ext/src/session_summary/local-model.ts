/**
 * session_summary/local-model.ts — the LOCAL fallback of session-summary (TRDD-TYHKAKCB).
 *
 * WHY this exists: session-summary used to pick only ':free' OpenRouter models (model-select.ts), so a machine with
 * no reachable remote free model could not summarize (or Jev-compact, `session compact` is this command) a session at
 * all. Owner goal 2026-11-14 (TRDD-EB1XGLMJ): "jev compaction must work perfectly too, local or remote api, and so the
 * summariztion of the session via local models like liquidai LFM3 1.7B. Always use the locale inferencer".
 *
 * Decisions (agent, recorded on TRDD-TYHKAKCB):
 *  - Remote free models FIRST, the managed local model LAST: it is appended after every remote candidate, so the
 *    driver reaches it only once every remote model is demoted (gone, daily cap, no longer free), and it is the whole
 *    chain when the remote selection fails outright (catalog unreachable, nothing eligible).
 *  - An explicitly selected managed local profile (active or --profile) runs LOCAL-ONLY: its deps cannot reach the
 *    OpenRouter pool, and the user asked for local.
 *  - Only a MANAGED profile (server: managed) qualifies: its requests go through the broker, which holds governor
 *    leases (broker/server.ts), so they queue under the machine-wide CPU/RAM limits instead of failing. A raw server
 *    is never used (owner: "always use the local inferencer").
 *  - locals-mlx (LiquidAI/LFM3-1.7B-MLX-4bit) is preferred over local_llama (LFM3 GGUF): the card title asks for it.
 *  - Every model a managed profile lists (model, second, third; locals-mlx first) is a candidate, in that order, and
 *    each is sized ALONE from its own calibration record for the task kind session_summary maps to: AGGREGATE
 *    (local-input-budget.ts TASK_KIND_BY_TOOL). A model the calibration found unfit for aggregate (fill_tokens 0) is
 *    skipped with a line, never sent to (measured 2026-11-15: LFM3-1.7B-MLX-4bit is unfit for every kind). When every
 *    local model is unfit and no remote model is available, the command fails naming each model and its reason.
 *
 * Pure apart from reading the calibration records under `dir`; every other effect (the remote catalog, the
 * calibration wait, stderr) is injected, so the selection is tested against real temp dirs with no network.
 */

import { resolveProfile, type Profile, type ResolvedProfile } from "../config.js";
import type { BrokerEngine } from "../broker/protocol.js";
import { engineOf } from "../calibration/commands.js";
import { resolveRequestOptions } from "../provider/request-options.js";
import { readRecordStatus } from "../calibration/record.js";
import { enqueueUnlocked, readQueue, withStateLock } from "../calibration/state.js";
import { liveCalibrator } from "../calibration/runner.js";
import { localEngineOf, planLocalSizing } from "../local-input-budget.js";
import { TOKEN_ESTIMATE_SAFETY_MARGIN } from "./chunker.js";
import { MAX_SUMMARY_COMPLETION_TOKENS, PROMPT_OVERHEAD_TOKENS, mapPromptOverheadBytes } from "./driver.js";
import type { EligibleModel } from "./model-select.js";

/** The managed local profiles that may serve session-summary, in preference order (TRDD-TYHKAKCB: Locals first). */
export const LOCAL_SUMMARY_PROFILES = ["locals-mlx", "local_llama"] as const;

/**
 * The most characters one GPT (o200k) token covers in a transcript, for converting the calibrated BYTE budget into the
 * chunker's token units. WHY needed: the chunker counts o200k tokens x TOKEN_ESTIMATE_SAFETY_MARGIN (chunker.ts), the
 * calibration measured the local model's own tokenizer (local-input-budget.ts budgetBytes). A chunk of B bytes counts
 * at least B / this x margin chunker tokens, so a chunker budget of bytes x margin / this can never pack more than
 * `bytes` as long as no token covers more characters than this. WHY 5 and not the ~4 o200k averages on English: an
 * average undercounts runs of long words, and an overflow costs a failed request on a small window. NOT raised for
 * pathological text (a repeated long word packs ~6 characters per token; coordinator 2026-11-15: raising the ceiling
 * doubles local requests on normal text): such a chunk is rejected by the server as a context overflow and the driver
 * re-splits it (classifyContextOverflow + shrinkBudgetOnOverflow; local-model.test.ts shows the re-split).
 */
export const CHUNKER_CHARS_PER_TOKEN_CEILING = 5;

/** The smallest chunker budget worth sending (below it the driver's own 1_000-token floor would overstate the window). */
export const MIN_LOCAL_CHUNK_TOKENS = 1_000;

/** The profile fields this module reads; a ResolvedProfile satisfies it. */
export type LocalSummaryProfile = Pick<ResolvedProfile, "name" | "server" | "model" | "secondModel" | "thirdModel" | "contextWindow" | "routeForModel" | "requestOptions">;

/** One model of a managed local profile that may serve session-summary: its id, engine and the broker context per request. */
export interface LocalSummaryTarget<P extends LocalSummaryProfile = LocalSummaryProfile> {
  profile: P;
  model: string;
  engine: BrokerEngine;
  /** The context the broker gives one request (index.ts brokerSlotCtx), the same value localBroker starts the server with. */
  ctx: number;
}

/**
 * The targets `profile` offers (every listed model on its broker route, in model/second/third order), or why none.
 * WHY the route must be the primary group: the broker serves only the profile's own group (index.ts localBroker,
 * route-for-tier.ts), so a model on a providers[] route would bypass it and the governor.
 */
export function localSummaryTargetsOf<P extends LocalSummaryProfile>(profile: P, slotCtx: (contextWindow: number) => number): Array<LocalSummaryTarget<P>> | string {
  if (profile.server === null) return `profile '${profile.name}' is not managed (server: managed), so no broker or governor serves it`;
  const targets: Array<LocalSummaryTarget<P>> = [];
  for (const model of [...new Set([profile.model, profile.secondModel, profile.thirdModel].filter((m) => typeof m === "string" && m.length > 0))]) {
    const route = profile.routeForModel(model);
    const engine = route !== null && route.primary === true ? localEngineOf(route.api) : null;
    if (engine !== null) targets.push({ profile, model, engine, ctx: slotCtx(profile.contextWindow) });
  }
  return targets.length > 0 ? targets : `profile '${profile.name}' has no broker route for any of its models`;
}

/**
 * Every usable local target among `candidates` (already in LOCAL_SUMMARY_PROFILES order), plus one note per
 * candidate passed over. WHY notes and not a throw: a broken local profile must not take down a remote run that
 * never needed it, but it must not be silent either.
 */
export function pickLocalSummaryTargets<P extends LocalSummaryProfile>(
  candidates: readonly P[],
  slotCtx: (contextWindow: number) => number,
): { targets: Array<LocalSummaryTarget<P>>; notes: string[] } {
  const notes: string[] = [];
  const targets: Array<LocalSummaryTarget<P>> = [];
  for (const p of candidates) {
    const t = localSummaryTargetsOf(p, slotCtx);
    if (typeof t === "string") notes.push(t);
    else targets.push(...t);
  }
  return { targets, notes };
}

/** The local model sized for the driver, a calibration to wait for, or why it cannot be used. */
export type LocalSummaryPlan =
  | { state: "ready"; model: EligibleModel }
  | { state: "await"; models: Array<{ engine: BrokerEngine; model: string }>; head: string }
  | { state: "unusable"; reason: string };

/**
 * Size one local model for the driver from its calibration record (local-input-budget.ts planLocalSizing, task
 * kind aggregate for session_summary). The returned EligibleModel is shaped so the driver's own budget arithmetic
 * (windowBudgetForModel: context - min(completion, MAX_SUMMARY_COMPLETION_TOKENS) - PROMPT_OVERHEAD_TOKENS) yields
 * exactly the chunker budget computed here, and maxCompletionTokens is the calibrated output cap, so the request's
 * max_tokens is what the calibration reserved. WHY bytes and not inputTokens: inputTokens are the LOCAL tokenizer's,
 * the chunker counts GPT tokens; bytes are the unit both sides share, and they include the map prompt header.
 */
export function planLocalSummaryModel(dir: string, target: LocalSummaryTarget, userMaxOutput?: number): LocalSummaryPlan {
  let sizing;
  try {
    sizing = planLocalSizing({ dir, tool: "session_summary", members: [{ model: target.model, engine: target.engine, managed: true, ctx: target.ctx }], userMaxOutput });
  } catch (e) {
    // An unfit kind or a context too small for the output cap (spec 6): the model cannot take this command.
    return { state: "unusable", reason: (e as Error).message };
  }
  if (sizing === null) return { state: "unusable", reason: `session_summary has no local task kind for '${target.model}'` };
  if (sizing.state === "await") return { state: "await", models: sizing.models, head: sizing.head };
  if (sizing.state === "default") return { state: "unusable", reason: `'${target.model}' (${target.engine}) has no ok calibration record (llm-ext models calibration-status)` };
  const bodyBytes = sizing.budgetBytes - mapPromptOverheadBytes();
  const chunkTokens = Math.floor((bodyBytes * TOKEN_ESTIMATE_SAFETY_MARGIN) / CHUNKER_CHARS_PER_TOKEN_CEILING);
  if (chunkTokens < MIN_LOCAL_CHUNK_TOKENS) {
    return {
      state: "unusable",
      reason: `'${target.model}' leaves ${chunkTokens} transcript tokens per chunk (calibrated input ${sizing.budgetBytes} bytes, map prompt ${mapPromptOverheadBytes()} bytes); below ${MIN_LOCAL_CHUNK_TOKENS} (raise the profile context_window)`,
    };
  }
  return {
    state: "ready",
    model: {
      id: target.model,
      contextLength: chunkTokens + Math.min(sizing.maxTokens, MAX_SUMMARY_COMPLETION_TOKENS) + PROMPT_OVERHEAD_TOKENS,
      maxCompletionTokens: sizing.maxTokens,
      local: true,
    },
  };
}

export interface ResolveSessionSummaryModelsOptions {
  /** The selected profile is a managed local one: run local-only (no remote selection at all). */
  localOnly: boolean;
  /** The managed local targets in preference order (pickLocalSummaryTargets); empty when none. */
  locals: readonly LocalSummaryTarget[];
  /** The remote free models, biggest context first (selectModels plus the max-completion filter); throws when none. */
  remote: () => Promise<EligibleModel[]>;
  /** The config dir holding the calibration records. */
  dir: string;
  /** The request_options max_output_tokens for session_summary of a target's profile, when set. */
  userMaxOutput?: (target: LocalSummaryTarget) => number | undefined;
  /** Wait until every listed model has a calibration record (index.ts waitForCalibration + startCalibration). */
  waitForCalibration: (models: Array<{ engine: BrokerEngine; model: string }>, head: string) => Promise<void>;
  /** One stderr line (newline included). */
  write: (line: string) => void;
  /** Queue the given uncalibrated targets for a background calibration (queueLocalCalibrations); absent: nothing is queued. */
  queueCalibration?: (targets: readonly LocalSummaryTarget[]) => Promise<void>;
}

const nameOf = (t: LocalSummaryTarget): string => `${t.model} (profile '${t.profile.name}')`;

/**
 * The first local target that is ready, walking `locals` in order; every unfit or unusable one is skipped with its
 * reason, and the targets still missing a calibration record are listed. Pure apart from reading the records.
 */
function firstReadyLocal(o: ResolveSessionSummaryModelsOptions): { ready: { target: LocalSummaryTarget; model: EligibleModel } | null; skipped: string[]; awaiting: LocalSummaryTarget[] } {
  const skipped: string[] = [];
  const awaiting: LocalSummaryTarget[] = [];
  for (const t of o.locals) {
    const plan = planLocalSummaryModel(o.dir, t, o.userMaxOutput?.(t));
    if (plan.state === "ready") return { ready: { target: t, model: plan.model }, skipped, awaiting };
    if (plan.state === "unusable") skipped.push(`${nameOf(t)}: ${plan.reason}`);
    else awaiting.push(t);
  }
  return { ready: null, skipped, awaiting };
}

/**
 * The ordered model chain session-summary hands the driver: remote free models first, the first ready local model
 * last (see the module header). Throws when no chain exists: fail fast with the remote failure and every local reason.
 */
export async function resolveSessionSummaryModels(o: ResolveSessionSummaryModelsOptions): Promise<EligibleModel[]> {
  /** A local model as the WHOLE chain: wait for calibrations here, since nothing else can summarize. */
  const localAlone = async (why: string): Promise<EligibleModel[]> => {
    if (o.locals.length === 0) throw new Error(`${why}; no managed local profile (${LOCAL_SUMMARY_PROFILES.join(", ")}) can serve session-summary`);
    for (;;) {
      const r = firstReadyLocal(o);
      for (const line of r.skipped) o.write(`[llm-externalizer] session-summary: local model skipped: ${line}\n`);
      if (r.ready !== null) {
        o.write(`[llm-externalizer] session-summary: ${why}; summarizing with the local model ${nameOf(r.ready.target)} through the local broker\n`);
        return [r.ready.model];
      }
      // WHY one model at a time, in preference order: a calibration takes hours, and the preferred model may be fit.
      // waitForCalibration returns once it has a record, ok or not; the next pass sizes it or skips it as unfit.
      const next = r.awaiting[0];
      if (next === undefined) {
        // Every local model is unfit or unusable: never send to one, never pass silently.
        throw new Error(`${why}; every local model is unusable for session-summary (task kind aggregate): ${r.skipped.join("; ")}`);
      }
      // WHY head "": waitForCalibration throws on a FAILED record of its head; here a failed calibration is one more
      // skipped model (the next pass reports it as unusable and moves on), not the end of the command.
      await o.waitForCalibration([{ engine: next.engine, model: next.model }], "");
    }
  };
  if (o.localOnly) return localAlone("the selected profile is local");
  let remote: EligibleModel[];
  try {
    remote = await o.remote();
  } catch (e) {
    // WHY the remote failure is kept in the message: when no local model can serve either, the user must see both causes.
    return localAlone(`no remote free model is available (${(e as Error).message})`);
  }
  if (o.locals.length === 0) return remote;
  const r = firstReadyLocal(o);
  for (const line of r.skipped) o.write(`[llm-externalizer] session-summary: local fallback skipped: ${line}\n`);
  if (r.ready !== null) return [...remote, r.ready.model];
  // WHY no calibration wait while remote models exist: a calibration takes hours, and the local model is only the last fallback here.
  // WHY queued in the background instead (coordinator decision 2026-11-15): otherwise a machine that never calibrated
  // its local models would never get a local fallback for the next remote outage.
  // WHY only the first (preferred) uncalibrated model: a calibration takes hours and may download a model; one at a
  // time in preference order, as localAlone waits. Once it has a record the next run queues the next one if still needed.
  if (r.awaiting.length > 0) await o.queueCalibration?.(r.awaiting.slice(0, 1));
  if (r.awaiting.length > 0) o.write(`[llm-externalizer] session-summary: ${r.awaiting.map(nameOf).join(", ")} has no calibration record yet; this run has no local fallback\n`);
  else o.write(`[llm-externalizer] session-summary: no local model is fit for session-summary (task kind aggregate); this run has no local fallback\n`);
  return remote;
}

/** Keys (dir, engine, model) this process already decided to queue: the at-most-once-per-process rule. */
const queuedThisProcess = new Set<string>();

/** Test-only: forget the per-process queue memo. */
export function __resetQueuedCalibrationsForTests(): void {
  queuedThisProcess.clear();
}

/**
 * Queue uncalibrated local targets for calibration in the background, the way `llm-ext models calibrate` does
 * (calibration/commands.ts queueManual: reason manual, never --force), then make sure a runner works on them
 * (startRunner: the detached ensureCalibrator, which never waits for the calibration). Idempotent (coordinator
 * 2026-11-15): at most once per model per process (queuedThisProcess), never while a calibration runner is already
 * active (liveCalibrator, the status `llm-ext models calibration-status` reads), never for a model already in the queue
 * or with a record of any kind. One line per model newly queued. Returns those models.
 * WHY a failure here is a line and not a throw: it runs on a remote run that does not need the local model.
 * NEVER BLOCKS on the calibration state lock: a busy lock skips this run with one line (see the enqueue below).
 */
export async function queueLocalCalibrations(o: {
  dir: string;
  profiles: Readonly<Record<string, Profile>>;
  targets: readonly LocalSummaryTarget[];
  startRunner: () => Promise<unknown>;
  write: (line: string) => void;
}): Promise<string[]> {
  const pending = o.targets.filter((t) => !queuedThisProcess.has(`${o.dir}\u0000${t.engine}\u0000${t.model}`));
  if (pending.length === 0) return [];
  // WHY not while a runner works: it is already calibrating (or about to take the queue); a second trigger from a
  // summary run would only race it. The next run after it finishes decides again.
  const runner = await liveCalibrator(o.dir);
  if (runner !== null) {
    o.write(`[llm-externalizer] session-summary: a calibration runner is active (pid ${runner.pid}); not queueing ${pending.map(nameOf).join(", ")} now\n`);
    return [];
  }
  const queued = readQueue(o.dir);
  const toQueue: LocalSummaryTarget[] = [];
  for (const t of pending) {
    queuedThisProcess.add(`${o.dir}\u0000${t.engine}\u0000${t.model}`);
    if (queued.some((q) => q.engine === t.engine && q.model === t.model)) continue;
    if (readRecordStatus(o.dir, t.engine, t.model).state !== "missing") continue;
    // queueManual's engineOf check, kept: it refuses a model no managed profile names, or one named by profiles of
    // both engines (calibration needs one engine). Same refusal text, one line, never a throw.
    const e = engineOf(o.profiles, t.model);
    if ("error" in e) {
      o.write(`[llm-externalizer] session-summary: could not queue ${nameOf(t)} for calibration: ${e.error}\n`);
      continue;
    }
    toQueue.push(t);
  }
  if (toQueue.length === 0) return [];
  // WHY waitMs 0 and not queueManual (TRDD-TYHKAKCB known cost): queueManual waits up to 30 s for the calibration state
  // lock, and withStateLock waits SYNCHRONOUSLY (Atomics.wait), so a busy lock froze a remote summary run for 30 s over
  // a background chore it does not need. With 0 it tries once (plus at most one 20 ms poll) and gives up. A busy lock
  // means another process (a runner, the CLI, a broker) is writing the state right now; this run skips with one line
  // and forgets the per-process memo, so the next run (or the next call in this process) tries again.
  // The enqueue itself is the same as queueManual's (reason manual, never --force); queueManual's record check is
  // covered by the readRecordStatus "missing" filter above.
  const done = withStateLock(o.dir, 0, () => {
    for (const t of toQueue) enqueueUnlocked(o.dir, { engine: t.engine, model: t.model, reason: "manual", force: false });
    return true;
  });
  if (done === undefined) {
    for (const t of toQueue) queuedThisProcess.delete(`${o.dir}\u0000${t.engine}\u0000${t.model}`);
    o.write(`[llm-externalizer] session-summary: the calibration state lock is busy; not queueing ${toQueue.map(nameOf).join(", ")} for calibration now (a later run retries)\n`);
    return [];
  }
  const fresh = toQueue.map((t) => t.model);
  for (const t of toQueue) o.write(`[llm-externalizer] session-summary: queued '${t.model}' (${t.engine}, profile '${t.profile.name}') for calibration in the background (llm-ext models calibration-status)\n`);
  if (fresh.length > 0) {
    try {
      await o.startRunner();
    } catch (e) {
      o.write(`[llm-externalizer] session-summary: the calibration runner could not be started: ${(e as Error).message}\n`);
    }
  }
  return fresh;
}

/** The local model the chain ends on and the provider deps that send to it (its broker), when the chain has one. */
export interface SessionSummaryLocal<D> {
  modelId: string;
  deps: D;
}

/** What index.ts injects into resolveSessionSummaryChain: everything that lives in index.ts or touches a process. */
export interface SessionSummaryChainSeams<D> {
  /** The profile the command runs under (active, or the --profile one). */
  active: ResolvedProfile | null;
  /** settings.yaml profiles (the built-in local ones live there once migrated). */
  profiles: Readonly<Record<string, Profile>> | undefined;
  /** An explicit --min-context: a hard floor, so no local fallback (it never meets a remote floor). */
  minContext?: number;
  dir: string;
  /** The broker context per request of a managed profile (index.ts brokerSlotCtx). */
  slotCtx: (contextWindow: number) => number;
  /** The remote free models (model-select.ts selectModels). */
  selectRemote: (minContext?: number) => Promise<EligibleModel[]>;
  /** The provider deps of a local profile (index.ts makeProviderDeps over makeBackendFromProfile): its broker. */
  depsFor: (profile: ResolvedProfile) => D;
  /** Start the detached calibration runner (calibration/runner.ts ensureCalibrator). */
  startCalibrationRunner: () => Promise<unknown>;
  /** Wait for calibration records (index.ts waitForCalibration + startCalibration). */
  waitForCalibration: (models: Array<{ engine: BrokerEngine; model: string }>, head: string) => Promise<void>;
  write?: (line: string) => void;
}

/**
 * The whole session-summary model selection (TRDD-TYHKAKCB): the local candidates, the remote selection, the chain,
 * and the deps of the local model when the chain ends on one. Kept here so index.ts only injects its seams.
 */
export async function resolveSessionSummaryChain<D>(s: SessionSummaryChainSeams<D>): Promise<{ models: EligibleModel[]; local: SessionSummaryLocal<D> | null }> {
  const write = s.write ?? ((line: string) => void process.stderr.write(line));
  const profiles = s.profiles ?? {};
  // A selected local profile runs local-only: its deps cannot reach the OpenRouter pool, and the user asked for local.
  const localOnly = s.active?.isLocal === true;
  const candidates = localOnly && s.active !== null ? [s.active] : LOCAL_SUMMARY_PROFILES.flatMap((n) => (profiles[n] !== undefined ? [resolveProfile(n, profiles[n])] : []));
  const pick = pickLocalSummaryTargets(candidates, s.slotCtx);
  for (const note of pick.notes) write(`[llm-externalizer] session-summary: ${note}\n`);
  const locals = localOnly || s.minContext === undefined ? pick.targets : [];
  const models = await resolveSessionSummaryModels({
    localOnly,
    locals,
    remote: async () => {
      // Moved from index.ts: a model with no completion ceiling cannot size the prompt.
      const remote = (await s.selectRemote(s.minContext)).filter((m) => m.maxCompletionTokens > 0);
      if (remote.length === 0) throw new Error("every eligible free model reports no max_completion_tokens on the OpenRouter catalog — cannot size the summarization prompt safely");
      return remote;
    },
    dir: s.dir,
    userMaxOutput: (t) => resolveRequestOptions(t.profile.requestOptions, "session_summary")?.maxOutputTokens,
    waitForCalibration: s.waitForCalibration,
    write,
    queueCalibration: async (targets) => {
      await queueLocalCalibrations({ dir: s.dir, profiles, targets, startRunner: s.startCalibrationRunner, write });
    },
  });
  const localModel = models.find((m) => m.local === true);
  const target = localModel === undefined ? undefined : locals.find((t) => t.model === localModel.id);
  return { models, local: target === undefined ? null : { modelId: target.model, deps: s.depsFor(target.profile) } };
}
