// C4-07 (TRDD-MVT4DCHS), plan §9 `classify ping`, §3 L4: a free key check plus one noul question, `--no-call` to skip the question.
// WHY not a DecisionSpec: ping has no input, no thresholds, no projection and no envelope; running it through the generic runner would need a fake spec for each of those. It reuses the same pieces the runner uses: profile resolution, the environment key, the L0 transport and the redactor.
import { commandStopExitCode, commandStopFlag, commandStopSignal, isCommandStopped, type StopExitCode } from "../../command-stop.js";
import { OPENROUTER_ATTRIBUTION_HEADERS, throwIfStopped } from "../../provider/http.js";
import { safeReadText } from "../../safe-body.js";
import { DeadlineError, createDeadline } from "../l0/deadline.js";
import { ClassifierError, badResponseError, classifyHttpError } from "../l0/errors.js";
import { parseDecisionsText } from "../l0/response.js";
import { MAX_REPLY_BYTES, callDecisions, type GlobalFetch } from "../l0/transport.js";
import { noul } from "../l1/questions.js";
import { CTRL_C_EXIT_CODE, installCtrlC, type SignalSource } from "../l2/abort.js";
import { exitCodeForError } from "../l2/attention.js";
import { asClassifierError } from "../l2/fan-out.js";
import { resolveClassifierApiKey, resolveClassifierProfile, type ClassifierProfileInput, type ResolvedClassifierProfile } from "../l2/profile.js";
import { createRedactor } from "../l2/redact.js";
import { recordRequest, withUsageContext } from "../../usage-history.js";
import { PING_FLAGS } from "./ping-flags.js";
import { answerWithLocalDecider } from "../l2/local-fallback.js";
import type { LocalDeciderDeps } from "../l2/local-decider.js";

// WHY a constant here: the transport owns the decisions URLs (l0/transport.ts endpointUrl), but the key check is not a decisions call.
export const KEY_URL = "https://openrouter.ai/api/v1/key";

/** The overall budget of the local decider escalation of ping (ms). WHY exported: the test pins the wiring to this number. */
export const PING_LOCAL_REQUEST_TIMEOUT_MS = 30000;

/** The seams: settings, the one GlobalFetch (the only test seam), the two output lines and the SIGINT source. */
export interface PingDeps {
  settings: ClassifierProfileInput["settings"];
  fetch: GlobalFetch;
  sigint?: SignalSource;
  stdout(text: string): void;
  stderr(line: string): void;
  /** The raw `local_fallback` section of settings.yaml, for the local decider escalation; absent = its defaults. */
  localFallback?: unknown;
  /** The decider's own seams (process scan, clock, platform, install check), so the escalation is testable without
   * reaching the real machine. WHY required in practice: without it a test that fails its remote call would
   * probe and adopt the real `mlx-decision` singleton. Production leaves it out and local-decider.ts supplies the real ones. */
  localFallbackDeps?: Partial<LocalDeciderDeps>;
}

/** 0 ok, 1 refused call (bad option, unknown profile), 3 key/credits, 4 rejected, 5 failed after retries (attention.ts), 124 stopped by --command_timeout (StopExitCode, command-stop.ts; the type also admits 6 for --stop_on_errors, which ping never triggers today: stopIfStopOnErrors is called only from index.ts and free-rotation.ts, never on the classifier path), 130 Ctrl-C. */
export type PingExit = 0 | 1 | 3 | 4 | 5 | StopExitCode | typeof CTRL_C_EXIT_CODE;

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * The free key check. WHY only numbers are read from the reply: the `label` OpenRouter returns is derived from the key text, so it is never printed or kept.
 * WHY redirect "error": the API never redirects, and following a 3xx would send the key to wherever it points (as the transport does).
 */
async function checkKey(profile: ResolvedClassifierProfile, key: string, deps: PingDeps, signal: AbortSignal): Promise<string> {
  const deadline = createDeadline({ timeoutMs: profile.timeoutMs, signal });
  try {
    let res: Response;
    try {
      res = await deps.fetch(KEY_URL, { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_ATTRIBUTION_HEADERS }, signal: deadline.signal });
    } catch (e) {
      deadline.throwIfDone();
      throw e;
    }
    const text = await safeReadText(res, MAX_REPLY_BYTES);
    if (!res.ok) throw classifyHttpError(res.status, res.headers, text);
    let data: unknown;
    try {
      data = (JSON.parse(text) as { data?: unknown }).data;
    } catch {
      throw badResponseError("the key check reply is not valid JSON");
    }
    if (data === null || typeof data !== "object") throw badResponseError("the key check reply has no `data` object");
    const d = data as Record<string, unknown>;
    const usage = finite(d.usage);
    const limit = finite(d.limit);
    const left = finite(d.limit_remaining);
    return `key check: ok (profile ${profile.name}, ${profile.apiKeyEnv} accepted; spent ${usage === undefined ? "unknown" : `${usage} USD`}, ${limit === undefined ? "no spend limit" : `limit ${limit} USD, ${left === undefined ? "remaining unknown" : `${left} USD left`}`})`;
  } finally {
    deadline.dispose();
  }
}

// WHY this question (quality eval of run 20261031_191133): the old one ("Is `state` a complete sentence?" on "Ping from llm-ext: the sky is blue.") was ambiguous and got 0.26 to 0.35 across runs, so an answer could not tell a healthy model from a degraded one. This one states its fact verbatim: a working model answers high.
export const PING_STATE = "Water boils at 100 degrees Celsius at sea level.";
export const PING_QUESTION = "Does `state` say that water boils at 100 degrees Celsius at sea level?";
export const PING_EXPECTED_ABOVE = 0.5;
/**
 * The one paid question. WHY the profile model as written and no catalog lookup: ping must work when the catalog cache is cold or the catalog is the thing that is down, and it needs no limits.
 * WHY the answer is checked: a 200 with no usable `ping` answer is a broken service, not a pass.
 * Review of 3e281b35, finding 9: the reply cost is written to the usage history (recordRequest needs only the figure the reply carries, not the catalog price table), so the lifetime totals include it; a reply with no cost is not written (the user is told). `--max-budget` does not apply: ping takes no budget flag, and says so in its description.
 * WHY the local decider is asked too (mlx-decision increment 2): ping is the command a user runs to find out whether
 * decisions work at all, so it is the one place where "the remote side is down" must still produce a usable answer.
 * The free key check before it is NOT local: it answers whether the key is valid, and a local answer cannot.
 */
async function askOne(profile: ResolvedClassifierProfile, key: string, deps: PingDeps, signal: AbortSignal, historyFailures: string[]): Promise<string> {
  const started = Date.now();
  const deadline = createDeadline({ timeoutMs: profile.timeoutMs, signal });
  let remoteTimedOut = false;
  // WHY hoisted with remoteTimedOut: the outer catch needs it, and it doubles as "the local decider answered" (set only when the escalation returned a reply), so no second flag can drift from it.
  let remoteError: ClassifierError | undefined;
  try {
    let reply: { model: string; usage: { input_tokens: number; output_tokens: number; cost?: number }; answers: Record<string, unknown> };
    try {
      reply = await callDecisions(
        {
          endpoint: profile.endpoint,
          model: profile.model,
          state: PING_STATE,
          questions: { ping: noul(PING_QUESTION) },
          provider: profile.provider,
          sessionId: profile.sessionId,
          user: profile.user,
          trace: profile.trace,
        },
        { key, deadline, maxAttempts: profile.maxAttempts, fetchImpl: deps.fetch, parseReply: (text) => parseDecisionsText(text, () => undefined) },
      );
    } catch (e) {
      // WHY the failure state is captured FIRST (TRDD-O93LFMF3, as run-decision.ts:455-463 does, where a timeout is the common case for the local fallback): a remote TIMEOUT escalates to the local decider, a Ctrl-C does not.
      // Before this, throwIfDone() rethrew every spent deadline here, so the common failure (the remote call hangs to timeout_ms) never reached the local tier. Ctrl-C ("aborted") is still rethrown: it must not start a model load.
      // Accepted costs: the local tier has its own 30 s cap (PING_LOCAL_REQUEST_TIMEOUT_MS), so the timeout path can take up to timeout_ms + 30 s (the 500-near-deadline path already could);
      // a remote attempt that timed out on the client may still have been billed upstream, and ping records no cost for it (unchanged: no reply arrived to read a cost from).
      // Anything that is not a ClassifierError is a bug in ping's own reply parsing, not a remote failure, and is rethrown below.
      remoteTimedOut = deadline.reason === "timeout";
      const remoteFailedInTime = deadline.reason === undefined;
      if (deadline.reason === "aborted") deadline.throwIfDone();
      // WHY throwIfStopped here, before the ClassifierError check and before the escalation (TRDD-O93LFMF3, mirrors 23726401 in run-decision.ts): the per-request
      // deadline composes only Ctrl-C (l2/abort.ts), so deadline.throwIfDone() above never sees a command stop (--command_timeout or --stop_on_errors).
      // Without this a stop that landed during the remote attempts still started the local tier: the decider was probed and called after the stop, and
      // the CommandStoppedError the transport throws at the top of its retry loop is not a ClassifierError, so it fell through as an unclassified failure (exit 5).
      // The deadline and checkKey stay on the Ctrl-C-only signal by choice (TRDD-O93LFMF3, 2026-11-14): a request already in flight is not aborted on a stop, as in run-decision (the transport checks the stop only between attempts), because an aborted reply may still be billed with no cost record, and STOP_FLUSH_GRACE_MS in cli/main.ts bounds the wait. Wrong reporting is NOT the reason: runPing checks isCommandStopped() before Ctrl-C, so a stop is never reported as Ctrl-C. In-flight aborts, if wanted, belong in the transport for every command.
      throwIfStopped();
      if (!(e instanceof ClassifierError)) throw e;
      const escalated = await answerWithLocalDecider({
        settings: { ...(deps.localFallback === undefined ? {} : { local_fallback: deps.localFallback }) },
        fetchImpl: deps.fetch,
        // WHY AbortSignal.any with the stop signal (TRDD-O93LFMF3, 23726401): the local call must end at once when the command stops, not only on Ctrl-C; an in-flight local POST is aborted and its answer is lost (behaviour change). A local answer that arrived before the stop is kept: the success path below never calls throwIfStopped.
        signal: AbortSignal.any([signal, commandStopSignal()]),
        // WHY a 30 s cap: ping is an interactive check, and the configured local_fallback budget (400 s by default) is for a planned run; a refusal said after 30 s beats a hang. Clamped inside answerWithLocalDecider, so it never lengthens the user setting.
        requestTimeoutMs: PING_LOCAL_REQUEST_TIMEOUT_MS,
        call: { state: PING_STATE, questions: { ping: noul(PING_QUESTION) }, provider: profile.provider, sessionId: profile.sessionId, user: profile.user, trace: profile.trace },
        decider: deps.localFallbackDeps,
      });
      // WHY the disabled case is silent: "off" is the configuration the caller chose; every other refusal
      // (unreachable, not installed, still loading, wrong model) is said, because the caller did not choose it.
      if (!escalated.ok) {
        // WHY first, before both stderr lines and for the disabled case too (TRDD-O93LFMF3, 23726401): local-fallback.ts still rewraps the governor stop error (a stop during a lease wait) as a plain ClassifierError, so the failure
        // looks like a local refusal; throwIfStopped turns it back into the stop, and ping then says it was stopped instead of printing "did not answer either" and the remote error.
        // Not stop-aware by choice: the remote fetch this catch handles had already ended (completed or timed out) before the stop was seen; see the comment above the first throwIfStopped in this catch.
        throwIfStopped();
        if (!escalated.disabled) deps.stderr(`llm-ext: the local decider fallback did not answer either: ${escalated.reason}`);
        // WHY (TRDD-O93LFMF3): a spent deadline stays the OUTCOME (the outer catch rethrows DeadlineError, exit code and message unchanged),
        // but it must not hide why the remote side failed. This fires only here, for the remote ClassifierError rethrown after the
        // escalation failed, so a local error can never be labelled as the remote one.
        // WHY a stderr line, not `cause`: runPing maps a DeadlineError through asClassifierError to a fresh timeoutError(), which drops any cause.
        if (remoteFailedInTime && deadline.reason === "timeout") deps.stderr(`llm-ext: the remote call had failed before the deadline ran out: ${e.message}`);
        throw e;
      }
      reply = escalated.reply;
      remoteError = e;
    }
    const local = remoteError !== undefined;
    const a = reply.answers.ping as { noul?: unknown } | undefined;
    const p = finite(a?.noul);
    const usable = p !== undefined && p >= 0 && p <= 1;
    // WHY after the answer check, with ok = usable (round 2, minor d): a billed but unusable reply is a failed request in the history, as for every other command. WHY skipped when the reply has no cost: writing 0 would put a request into the lifetime totals that the totals would show as free; the user is told instead. WHY the write failure is caught here: it must not turn a working service into a "ping failed" exit; it is said as what it is. WHY not for a local reply: answerWithLocalDecider already recorded it under its own endpoint, and a second line would count one call twice.
    if (local) {
      // nothing to record: the local call was recorded where it was made
    } else if (reply.usage.cost === undefined) deps.stderr("cost unknown; not added to the usage history");
    else {
      try {
        withUsageContext({ tool: "cli:classify-ping", params: "" }, () => recordRequest({ ok: usable, durationMs: Date.now() - started, costUsd: reply.usage.cost!, endpoint: profile.endpoint, inputTokens: reply.usage.input_tokens, strict: true }));
      } catch (e) {
        historyFailures.push((e as Error).message);
      }
    }
    if (!usable) throw badResponseError("the reply has no usable answer to the ping question");
    // WHY here, after the usable check, before the warning and before the return (TRDD-O93LFMF3): the user must learn that the remote call failed and a local model answered instead (a timeout is the common case), and the cause is said before the effect; an unusable local answer ends as a bad response and must not carry this line.
    if (remoteError !== undefined) deps.stderr(`llm-ext: the remote call failed: ${remoteError.message}; answered by the local decider`);
    // WHY a warning and still exit 0: ping is a round-trip check (key, service, history); a fixed question answered on the unexpected side is worth saying, but it does not make the service unreachable.
    if (p! < PING_EXPECTED_ABOVE) deps.stderr(`warning: the ping answer ${p} is below the expected ${PING_EXPECTED_ABOVE}: the service answered, but the model got the fixed question wrong`);
    const where = local ? `the local decider, no API key used` : `the remote service`;
    return `decision call: ok (${where}; model ${reply.model}, answer ${p}, expected above ${PING_EXPECTED_ABOVE}, cost ${reply.usage.cost === undefined || local ? "0 USD (local)" : `${reply.usage.cost} USD`})`;
  } catch (e) {
    // WHY not after a remote timeout or a local answer (TRDD-O93LFMF3): a spent deadline must not relabel an error that has its own cause. After a remote timeout the deadline is always spent, and a local answer (usable or not) can arrive after it,
    // so an unconditional throwIfDone would turn a bad response or a bug into "deadline exceeded". An escalation that FAILED after a remote error that came in time still ends as "deadline exceeded" (the a00ef96d design, ping.test.ts):
    // there remoteError is unset and remoteTimedOut is false, so throwIfDone runs. After a remote timeout and a failed escalation the thrown `e` already is the remote timeoutError, so the output is still "classify ping failed: deadline exceeded", exit 5.
    if (!remoteTimedOut && remoteError === undefined) deadline.throwIfDone();
    throw e;
  } finally {
    deadline.dispose();
  }
}

/** `argv` is what classifyArgv produced (kebab flags); main.ts strips `--profile`, so the launcher passes it separately. */
export async function runPing(argv: readonly string[], profileFlag: string | undefined, deps: PingDeps): Promise<PingExit> {
  const redactor = createRedactor();
  const say = (line: string, to: (s: string) => void): void => to(redactor.redact(line) as string);
  const fail = (m: string): PingExit => { say(`llm-ext: ${m}`, deps.stderr); return 1; };
  let noCall = false;
  let profileName = profileFlag;
  for (let k = 0; k < argv.length; k++) {
    const t = argv[k]!;
    if (t === PING_FLAGS[0]!.flag) { noCall = true; continue; }
    if (t === "--profile") {
      const v = argv[++k];
      if (v === undefined || v === "") return fail("--profile needs a value");
      profileName = v;
      continue;
    }
    return fail(`unknown option ${t} for classify ping`);
  }
  const resolved = resolveClassifierProfile({ settings: deps.settings, profileFlag: profileName, command: "classify ping" });
  if (!resolved.ok) return fail(resolved.error);
  const profile = resolved.profile;
  let key: string;
  try {
    key = resolveClassifierApiKey(profile);
  } catch (e) {
    say(`llm-ext: ${(e as Error).message}`, deps.stderr);
    return 3;
  }
  // WHY registered before anything is printed: whatever an upstream error text echoes of the key is replaced.
  redactor.register(key);
  const ctrlC = installCtrlC(deps.sigint);
  const historyFailures: string[] = [];
  try {
    say(await checkKey(profile, key, deps, ctrlC.signal), deps.stdout);
    if (noCall) {
      // WHY the caveat (TRDD-VUPK2NM7): a worker read "key check: ok" as "remote calls will work" while the account returned HTTP 402 Insufficient credits on every paid call.
      // The key endpoint (KEY_URL) reports only the per-key limit and spend, never the account credit balance, so --no-call cannot know it; the line says so.
      // WHY 'accepted', not 'valid': the key endpoint proves only that OpenRouter accepted the key, not that it can call the decisions model. WHY on this line and not the key-check line: the key-check line stays stable for anything that parses it.
      say("decision call: skipped (--no-call); the key was accepted, but the credit balance and the model call are not checked: run without --no-call to test a real call", deps.stdout);
      return 0;
    }
    // WHY the stderr wrapper (TRDD-O93LFMF3): askOne now prints upstream error text, which must pass the redactor like every other output line.
    say(await askOne(profile, key, { ...deps, stderr: (l) => say(l, deps.stderr) }, ctrlC.signal, historyFailures), deps.stdout);
    // WHY exit 1 (coordinator decision, round 2b): the paid call worked but the record of it was lost; a script must be able to tell that from a service failure by the message, and must not read it as a clean pass.
    if (historyFailures.length > 0) return fail(`the decisions service answered, but the usage history could not be written: ${historyFailures[0]}`);
    return 0;
  } catch (e) {
    // WHY first, before the Ctrl-C branch (TRDD-O93LFMF3, 23726401): cli/main.ts forces the stop exit code (124 for --command_timeout; no classifier path calls stopIfStopOnErrors, so --stop_on_errors cannot stop ping today) after runPing returns whatever it returned, so the message must match that exit code;
    // a stop is never reported as a failure of the remote service nor as Ctrl-C. The stop reason itself is printed once by main.ts endStoppedCommand, so it is not repeated here.
    // WHY keyed on the global stop state, not on the caught error: after a stop every failure reaching this catch is reported as the stop (as in run-decision); main.ts forces the stop exit code anyway, so message and exit code agree.
    // By design (TRDD-O93LFMF3): with --no-call a key check that finished before the stop prints its result and returns 0; after a --command_timeout stop, cli/main.ts endStoppedCommand prints the stop line (asynchronously, after the broker-job cancel) and main.ts re-forces exit 124. Only this runPing half is unit-testable in-process; the main.ts half is not tested: KEY_URL has no seam, process-level interception (a proxy or a fetch preload) was not attempted, and no seam is added on purpose (no test knobs in shipped code).
    if (isCommandStopped()) {
      say(`llm-ext: classify ping was stopped (${commandStopFlag()})`, deps.stderr);
      return commandStopExitCode();
    }
    if (ctrlC.signal.aborted || (e instanceof DeadlineError && e.reason === "aborted")) {
      say("llm-ext: interrupted by Ctrl-C", deps.stderr);
      return CTRL_C_EXIT_CODE;
    }
    const err: ClassifierError = asClassifierError(e);
    say(`llm-ext: classify ping failed: ${err.message}${err.remedy_hint ? ` ${err.remedy_hint}` : ""}`, deps.stderr);
    return exitCodeForError(err);
  } finally {
    ctrlC.dispose();
  }
}
