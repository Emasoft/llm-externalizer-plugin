/**
 * classifiers/l2/local-fallback.ts — the ESCALATION POLICY of the local decider tier (mlx-decision increment 2):
 * when every remote System One model has failed, ask the loopback decider instead of failing the run.
 *
 * WHY the section is read here and not in config.ts: config.ts validates `local_fallback` and must not import
 * from classifiers/ (the cycle rule at config.ts:202), so the DEFAULTS of a valid section live next to their one
 * consumer. The values below are policy, not measurements: `url` is the port the already-running mlx-decision server
 * usually listens on (the plugin does not install one); a singleton on any other port is still found by its process and sockets (local-discovery.ts).
 *
 * WHY `enabled` defaults to TRUE: the whole point of this tier is that a run still answers when every remote
 * model is unreachable, and llm-ext never starts a server (local-decider.ts): it only adopts the singleton that
 * is already running, or refuses. A user who does not want it writes `enabled: false`.
 */

import { localFallbackErrors } from "../../config.js";
import { LOCAL_ENDPOINT, recordRequest } from "../../usage-history.js";
import { computeBackoffMs } from "../../provider/http.js";
import { ClassifierError } from "../l0/errors.js";
import { asClassifierError } from "./fan-out.js";
import type { ExecReply } from "./fan-out.js";
import { createDeadline, DeadlineError, type Deadline } from "../l0/deadline.js";
import { callLocalDecisions } from "../l0/local-transport.js";
import type { GlobalFetch } from "../l0/transport.js";
import { ensureLocalDecider, SERVED_MODEL, type LocalDeciderConfig, type LocalDeciderDeps } from "./local-decider.js";
import { releaseDirectLease, takeDirectLease } from "../../governor/direct.js";

/** The port the already-running mlx-decision server listens on (127.0.0.1:8123); the plugin does not install one.
 * WHY a named export: the default url and the tests share one number. */
export const DECIDER_SINGLETON_PORT = 8123;

/** The defaults of the `local_fallback` section, key by key: the same keys config.ts validates. */
export const LOCAL_FALLBACK_DEFAULTS: LocalDeciderConfig = {
  enabled: true,
  /** WHY the singleton port: it is only the FIRST place looked at; discovery by process and listening sockets finds the singleton on any other port anyway. */
  url: `http://127.0.0.1:${DECIDER_SINGLETON_PORT}`,
  /** How long to wait for an ADOPTED singleton to finish loading its model: five minutes, since MLX loads the weights before /health reports them, and that is minutes, not seconds. */
  startTimeoutMs: 300000,
  /** Per-attempt timeout: MLX inference on a large state under load can exceed 200 s (USER, 2026-11-11). */
  attemptTimeoutMs: 200000,
  /** Overall deadline for the whole escalation: 400 s covers a load wait plus two full attempts (USER, 2026-11-11). */
  requestTimeoutMs: 400000,
  /** 50 POST attempts: the local server is sometimes very slow, not broken (USER, 2026-11-11). Lookups do not count. */
  maxAttempts: 50,
};

/**
 * The `local_fallback` section with its defaults applied. Throws on a malformed section: the settings loader
 * already folds localFallbackErrors into validateSettings, so reaching this with a bad section means a caller
 * built Settings by hand, and reading a typo as the default is exactly what that validation exists to prevent.
 */
export function localFallbackConfig(raw: unknown): LocalDeciderConfig {
  const errors = localFallbackErrors(raw);
  if (errors.length > 0) throw new Error(errors.join("; "));
  const section = (raw ?? {}) as Partial<LocalDeciderConfig>;
  return { ...LOCAL_FALLBACK_DEFAULTS, ...section };
}

/** The fixed pause between two looks for a decider that is not ready. WHY fixed and not computeBackoffMs: a look
 * is one probe plus one process scan, so nothing is hammered, and a singleton restart takes seconds, so a growing
 * backoff would only delay adopting it. computeBackoffMs stays for POST failures, where load really is the issue. */
const RESCAN_INTERVAL_MS = 2000;

/** How long a fully failed search for the decider short-circuits the next escalations of this process. */
const UNAVAILABLE_MEMO_MS = 60_000;

/** Per-process fast-fail memo (epoch ms; 0 = none). WHY: a planned run fans out many failed requests, and without
 * this each one would sit out its whole requestTimeoutMs re-looking for a singleton that is plainly not there, so
 * a machine without the server would turn every remote outage into minutes of waiting. While it is in the future
 * an escalation looks ONCE (without waiting for a load) and gives up; any success clears it, since the singleton
 * is then known to be up. */
let unavailableUntil = 0;

/** Test-only: forget the fast-fail memo, so one test cannot short-circuit the next. */
export function __resetLocalFallbackForTests(): void {
  unavailableUntil = 0;
}

/**
 * One local request at a time, machine-wide within this process. WHY: the USER rule for this decider is "just
 * wait until the previous tool completed the request to the server" (2026-11-10), and a planned run fans its
 * requests out concurrently (l2/fan-out.ts), so without this every failed request would reach the same 15 GB
 * server at once. It also makes the second caller wait for the first to finish looking for (and adopting) the
 * singleton before it looks itself.
 * WHY a promise chain and not a lock file: it must not leak a lock on a crash, and the singleton itself is the
 * cross-process exclusion (llm-ext starts no server, local-decider.ts), not this queue.
 */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function answerWithLocalDecider(opts: LocalEscalationOptions): Promise<LocalEscalation> {
  let cfg: LocalDeciderConfig;
  try {
    cfg = localFallbackConfig(opts.settings.local_fallback);
  } catch (e) {
    return { ok: false, disabled: false, reason: (e as Error).message };
  }
  if (!cfg.enabled) return { ok: false, disabled: true, reason: "the local decider fallback is disabled (local_fallback.enabled false)" };
  // WHY min and not the override alone: a caller may shorten the budget (ping must not hang for 400 s), but never
  // lengthen what the user configured.
  const requestTimeoutMs = Math.min(cfg.requestTimeoutMs, opts.requestTimeoutMs ?? cfg.requestTimeoutMs);

  // WHY the whole ensure+send pair inside the queue and not just the POST: a second caller must not probe while
  // the first is still waiting for the singleton to load, and one request at a time is the rule for the server.
  // The config read above stays outside: it touches nothing.
  return oneAtATime(async (): Promise<LocalEscalation> => {
    let baseUrl: string | undefined;
    const started = Date.now();
    // WHY a let: the outer deadline is paused during the governor lease wait and rebuilt when the lease is granted (see the lease block).
    let outerDeadline = createDeadline({ timeoutMs: requestTimeoutMs, signal: opts.signal });
    // WHY the deps carry the CURRENT outer deadline signal through a getter: outerDeadline.signal composes
    // opts.signal (Ctrl-C) AND the request budget, so the wait for a loading singleton (startTimeoutMs, up to 15
    // minutes) ends when the request budget does, instead of polling past the point the run gave up; and the getter
    // follows the deadline rebuilt after a lease wait, which a signal captured once would not.
    const deps: LocalDeciderDeps = {
      fetch: opts.fetchImpl,
      now: Date.now,
      get signal() {
        return outerDeadline.signal;
      },
      ...opts.decider,
    };
    // WHY read once, before the loop: a memo set by THIS escalation must not turn its own retries into fast-fails.
    const fastFail = deps.now() < unavailableUntil;
    // WHY startTimeoutMs 0 while unavailableUntil is live: the previous escalation already waited out its whole budget on
    // this singleton, so this one looks ONCE and must not sit through another load wait.
    const lookupCfg: LocalDeciderConfig = fastFail ? { ...cfg, startTimeoutMs: 0 } : cfg;
    // True while every failure so far was a retryable "decider not ready" refusal (the only kind the memo records).
    let onlyEnsureRefusals = true;
    let lastError: unknown;
    // The last refusal that said something about the singleton (not an abort): it survives a budget that ends
    // while a later lookup is cut short, so the final message names the real cause.
    let lastRefusal: string | undefined;
    // WHY counted apart from the lookups: maxAttempts bounds POSTs. A lookup for a not-ready singleton is bounded
    // by the outer deadline alone, otherwise a few rescans would use up the attempts before the singleton came up.
    let postAttempts = 0;
    for (;;) {
      // WHY the deadline/abort checks precede the ensure: an expired budget or a Ctrl-C must not probe for a
      // server the run has already given up on. Every pass below either returns, breaks or sleeps at least
      // RESCAN_INTERVAL_MS or a backoff against this deadline, so the loop always ends.
      // WHY !== undefined and not !== null: Deadline.reason is `DeadlineReason | undefined`, never null, so a
      // null test is true on the FIRST attempt and would never send a request at all.
      if (outerDeadline.reason !== undefined) break;
      if (opts.signal?.aborted) break;
      // WHY created only AFTER a successful ensure (below) and disposed on every path: the attempt budget is for
      // the POST. Started before the lookup, it would run during a load wait and abort the first POST of a
      // singleton that took longer than attemptTimeoutMs to load.
      // WHY createDeadline owns the per-attempt timer (and not AbortSignal.timeout + AbortSignal.any): a platform
      // AbortSignal.timeout timer is NOT cleared by dispose(), so every attempt orphaned one for the whole
      // attemptTimeoutMs. createDeadline timers ARE cleared by dispose(), and passing signal: outerDeadline.signal
      // makes its signal abort on either the attempt budget or the outer deadline.
      let attemptDeadline: Deadline | undefined;
      // WHY per attempt: tells the catch below whether the failure came from the decider lookup or from the POST.
      let ensureRefusal = false;
      try {
        // WHY the ensure is INSIDE the loop and inside this try: a not-ready singleton (restarting, still loading)
        // heals with time, so re-checking each pass turns a transient absence into a wait instead of a hard
        // failure of the run.
        // WHY inside the try: the refusal is thrown as a ClassifierError so the retry/backoff of the loop handles it;
        // thrown from outside the try it would escape answerWithLocalDecider, which contractually NEVER throws on
        // the failure path of a run that already lost its remote models.
        const ready = await ensureLocalDecider(lookupCfg, deps);
        if (!ready.ok) {
          ensureRefusal = true;
          // WHY the message of an aborted lookup is replaced: "aborted" is how the budget ending mid-wait looks from
          // inside the lookup, and it hides what the run was waiting for. The detail (still loading on <url>) or the
          // last real refusal says it.
          const message = ready.aborted === true ? (ready.detail ?? lastRefusal ?? ready.reason) : ready.reason;
          if (ready.aborted !== true) lastRefusal = ready.reason;
          // WHY ready.retryable and not the reason text: the decider module states whether time can heal the
          // refusal; matching on its wording would break silently the next time a sentence is edited.
          throw new ClassifierError({ class: "bad-response", message, retryable: ready.retryable, remedy_hint: ready.retryable ? "waiting for the mlx-decision singleton to become available; llm-ext never starts one and retries until the request budget ends" : undefined });
        }
        baseUrl = ready.baseUrl;
        // WHY every POST to the decider takes a machine-wide governor lease: many llm-ext processes (and every other
        // local inference on this machine) must be serialized and modulated in real time by the governor's CPU/RAM
        // limits and max_inferences (USER rule 2026-11-10: "just wait until the previous tool completed the request
        // to the server"; USER goal: local models under real-time modulation that never saturates RAM/CPU). The
        // in-process oneAtATime queue above stays: it orders THIS process, the lease orders the machine.
        // WHY the decider shares the inference window with llama/Locals inference and does not get a window of its own:
        // max_inferences defaults to 8 behind a CPU-adaptive window (governor/controller.ts), and the decider's
        // requests use the same CPU/GPU, so sharing the window IS the real-time modulation the USER asked for.
        // WHY no self-deadlock: this escalation runs after REMOTE calls failed, and takeDirectLease returns null for a
        // non-loopback url, so no lease is held on this path when the decider lease is taken here (it also returns
        // null for a disabled governor, and the POST then goes out directly).
        // WHY taken BEFORE the attempt deadline is created: the wait for the machine is not part of attemptTimeoutMs
        // (a POST queued behind other processes would otherwise be aborted before it started).
        // WHY the lease wait is NOT cut by the request budget: a full machine queues, it never fails the request.
        // USER 2026-10-28: "not having enough memory is not a failure, requests queue"; USER 2026-11-10: "just wait
        // until the previous tool completed the request to the server"; USER 2026-11-11: 200 s per decision attempt,
        // 400 s per request. Decided as TRDD-O93LFMF3 Q4 (recorded on TRDD-WSPV40Y5, 2026-11-14). So the wait ends only on
        // Ctrl-C (opts.signal), on the command stop takeDirectLease composes itself (--command_timeout), or on a
        // governor error. The request budget covers the decider lookup and the server request only, so the outer
        // deadline is PAUSED here (disposed, its remaining time kept) and REBUILT with that remaining time once the
        // lease is granted. A 60 s "lease-starved" memo that failed the next escalations after one starved wait used
        // to turn a saturated machine into failed requests; it is gone on purpose, do not bring it back.
        // WHY grantBudgetMs as the timeout argument: it is not a wait limit, it sets the lease expiry (grant time +
        // timeoutMs + EXPIRY_MARGIN_MS, governor/client.ts), and the rebuilt deadline lasts exactly that long, so the
        // lease always outlives the POST it guards. It is the remaining budget but never less than one full attempt
        // (attemptTimeoutMs): see the rebuild below.
        const budgetLeftMs = outerDeadline.remainingMs();
        const grantBudgetMs = Math.max(budgetLeftMs, cfg.attemptTimeoutMs);
        outerDeadline.dispose();
        let lease: Awaited<ReturnType<typeof takeDirectLease>>;
        try {
          lease = await takeDirectLease(ready.baseUrl, grantBudgetMs, { signal: opts.signal });
        } catch (governorError) {
          // WHY a final (non-retryable) ClassifierError and not a retry: a governor that cannot answer, a malformed
          // governor setting or a stopped command will not heal within this escalation, and a retry storm of
          // "request not sent" failures helps nobody. ensureRefusal stays false, so onlyEnsureRefusals goes false.
          const message = governorError instanceof Error ? governorError.message : String(governorError);
          // WHY Ctrl-C while queued is reported as such and not as a governor failure: the governor was healthy.
          throw new ClassifierError({
            class: "unavailable",
            message: opts.signal?.aborted === true ? "the wait for the local inference governor was cut short (aborted)" : message,
            retryable: false,
          });
        }
        // WHY rebuilt after the grant: the deadline disposed above must not run during the queue wait, so the request
        // budget starts counting again only now, when the server is about to be asked.
        // WHY at least cfg.attemptTimeoutMs and not the bare remainder: the lookup may have used nearly the whole
        // request budget (399 of 400 s), and a bare remainder would give the POST ~1 s after a wait of minutes, so the
        // request would fail on a machine that merely queued it. After any grant the server gets one full attempt;
        // further retries stay bounded by what the deadline then has left.
        outerDeadline = createDeadline({ timeoutMs: grantBudgetMs, signal: opts.signal });
        postAttempts++;
        // WHY the lease is released in a finally that covers only the POST: it must be given back on every path
        // (answer, POST throw, abort, attempt timeout), and held no longer than the server is actually computing.
        let decided: Awaited<ReturnType<typeof callLocalDecisions>>;
        try {
          attemptDeadline = createDeadline({ timeoutMs: cfg.attemptTimeoutMs, signal: outerDeadline.signal });
          decided = await callLocalDecisions(
            { model: SERVED_MODEL, ...opts.call },
            { baseUrl: ready.baseUrl, deadline: attemptDeadline, fetchImpl: opts.fetchImpl },
          );
        } finally {
          releaseDirectLease(lease);
        }
        const { reply } = decided;
        recordRequest({ ok: true, durationMs: Date.now() - started, costUsd: 0, endpoint: LOCAL_ENDPOINT, inputTokens: reply.usage.input_tokens });
        // WHY disposed on the success path too: the old code disposed in a finally, and an undisposed deadline
        // keeps its timer (and the caller-signal listener) alive for the whole budget of a call already answered.
        attemptDeadline.dispose();
        outerDeadline.dispose();
        // WHY cleared on success: the singleton just answered, so any earlier "not found" verdict is stale.
        unavailableUntil = 0;
        return {
          ok: true,
          reply: { model: reply.model, usage: reply.usage, cost: { costUsd: 0, cost_estimated: false }, answers: reply.answers },
          notice: `no remote System One model answered; the local decider ${reply.model} on ${ready.baseUrl} did (free, no API key used)`,
        };
      } catch (e) {
        attemptDeadline?.dispose();
        lastError = e;
        // WHY a budget that ended mid-wait still counts as a retryable refusal: the wait for a loading singleton
        // is cut by the outer deadline, which the decider reports as an abort (not retryable), but the cause was
        // our budget, not a verdict about the singleton. outerDeadline.reason is set to "timeout" by the deadline
        // own timer before it aborts the signal, so it is already readable here.
        const budgetEnded = outerDeadline.reason === "timeout";
        if (!ensureRefusal || !(budgetEnded || (e instanceof ClassifierError && e.retryable))) onlyEnsureRefusals = false;
        // Only retry retryable errors; bad-request/bad-response are final.
        if (e instanceof ClassifierError && !e.retryable) break;
        // WHY no retry while the memo is live: the previous escalation already searched for the whole budget and
        // found nothing, so this one looks exactly once and fails at once.
        if (fastFail && ensureRefusal) break;
        // WHY only POST failures hit the attempt cap: see postAttempts.
        if (!ensureRefusal && postAttempts >= cfg.maxAttempts) break;
        // WHY a fixed interval for a not-ready decider: see RESCAN_INTERVAL_MS. POST failures keep the backoff.
        const wait = ensureRefusal ? RESCAN_INTERVAL_MS : computeBackoffMs(postAttempts - 1, 0);
        const left = outerDeadline.remainingMs();
        if (wait >= left) break; // wait would exceed the outer deadline
        // WHY the outer deadline sleeps, not a bare setTimeout: a bare timer ignores Ctrl-C and the overall budget,
        // so an aborted run (or one that already spent the budget) sat out the whole backoff before the next
        // iteration noticed. A DeadlineError here means the deadline fired or the run was aborted: break so the
        // lastError/undefined handling below reports it, rather than letting it escape as a thrown exception.
        try {
          await outerDeadline.sleep(wait);
        } catch (sleepError) {
          if (!(sleepError instanceof DeadlineError)) throw sleepError;
          break;
        }
      }
    }
    outerDeadline.dispose();
    // WHY only when this escalation did the full search (not fastFail), ran with the CONFIGURED budget and the user did
    // not abort: the memo records "the whole configured budget found no ready decider". A shortened budget (ping: 30 s)
    // proves only that the singleton was not ready within that short window, and arming the memo from it would
    // fast-fail a following full-budget escalation that could have waited for a slow load. An aborted run proves
    // nothing, and re-arming on every fast-fail would postpone the next full search forever.
    // WHY only onlyEnsureRefusals arms THIS memo: it shortens the decider LOOKUP (startTimeoutMs 0, one refusal ends it), which is right only for "no ready decider".
    if (!fastFail && requestTimeoutMs === cfg.requestTimeoutMs && lastError !== undefined && onlyEnsureRefusals && opts.signal?.aborted !== true) {
      unavailableUntil = deps.now() + UNAVAILABLE_MEMO_MS;
    }
    // WHY this branch precedes the lastError===undefined guard: when the budget ends between attempts there IS a
    // lastError, so without it the run would report the stale per-attempt failure and hide that it ran out of time.
    if (outerDeadline.reason !== undefined && lastError !== undefined) {
      return { ok: false, disabled: false, reason: `the local decider ran out of its ${requestTimeoutMs} ms budget while retrying (last failure: ${asClassifierError(lastError).message})` };
    }
    // WHY lastError can be undefined: the loop may break before its first request (an expired outer deadline or
    // an aborted run), and asClassifierError(undefined) would report "undefined" as the failure.
    if (lastError === undefined) {
      return { ok: false, disabled: false, reason: `the local decider at ${baseUrl ?? cfg.url} was not asked: no attempt was started (${outerDeadline.reason ?? "aborted"})` };
    }
    const err = asClassifierError(lastError);
    return { ok: false, disabled: false, reason: `the local decider at ${baseUrl ?? cfg.url} could not answer after retries: ${err.message}${err.remedy_hint === undefined ? "" : ` ${err.remedy_hint}`}` };
  });
}

/** One local escalation: the fields the request carries, plus the seams (every one defaults to production). */
export interface LocalEscalationOptions {
  /** The raw `local_fallback` section of settings.yaml. */
  settings: { local_fallback?: unknown };
  fetchImpl: GlobalFetch;
  /** The Ctrl-C signal of the run: an aborted run must not keep waiting for a model. */
  signal?: AbortSignal;
  /** A shorter overall budget than local_fallback.requestTimeoutMs (ms); clamped to it, never longer. WHY: a command that must answer quickly (ping) cannot sit out the configured 400 s. */
  requestTimeoutMs?: number;
  call: { state: unknown; questions: Record<string, unknown>; provider?: Record<string, unknown>; sessionId?: string; user?: string; trace?: Record<string, unknown> };
  /** Test seams of the decider itself; production leaves them out and local-decider.ts supplies the real ones. */
  decider?: Partial<LocalDeciderDeps>;
}

/**
 * The reply of a local escalation, or why there is none. `notice` is the one line the caller records as a
 * warning and prints, so a local answer is never silent (the D1 rule for every fallback).
 */
export type LocalEscalation =
  | { ok: true; reply: ExecReply; notice: string }
  /** WHY a distinct shape: a caller prints every refusal as a line, and "the fallback is off" is the one
   * refusal the caller itself configured, so it needs to be told apart and said zero times, not once per
   * failed request. */
  | { ok: false; disabled: true; reason: string }
  | { ok: false; disabled: false; reason: string };
/**
 * Make the decider ready and ask it. NEVER throws: this runs on the failure path of a run that has already
 * lost its remote models, and a throw here would replace that failure with a bug report.
 */
