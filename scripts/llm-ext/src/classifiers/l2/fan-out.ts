// L2-04, plan §5 Execution: run a plan's requests in parallel and merge the replies. L2-05: what a request with no reply does to the result, per split class.
import { AdaptiveRateLimiter } from "../../rate-limiter.js";
import type { Answers, BuiltUnit, SplitClass } from "../catalog/spec.js";
import { DeadlineError, type Deadline } from "../l0/deadline.js";
import { ClassifierError, timeoutError, type ErrorClass } from "../l0/errors.js";
import { validateAnswers } from "../l1/validate-answers.js";
import type { ValidationPolicy } from "../l1/validate.js";
import { runCancellable } from "./abort.js";
import { defaultLabel, mergeChunks, type ChunkAnswer } from "./chunker.js";
import type { BudgetTracker } from "./cost-cap.js";
import type { EnvelopeReply } from "./envelope.js";
import { chunkOf, type Plan, type PlannedRequest } from "./planner.js";
import { warning, type Warning } from "./warnings.js";
import { CommandStoppedError, commandStopReason } from "../../command-stop.js";

/** What `exec` returns for one request: the billed reply as the envelope wants it, plus its raw answers. `exec` records the usage (before answer checks, plan §7) and reads the body with parseDecisionsReply. */
export type ExecReply = EnvelopeReply & { answers: Record<string, unknown> };

export interface RunPlanOptions<U extends BuiltUnit> {
  concurrency: number;
  /** Deadline of ONE request, retries included (plan §7). */
  timeoutMs: number;
  /** Ctrl-C. The run also aborts itself on a run-wide failure (FATAL_CLASSES); the caller's signal is never touched. */
  signal?: AbortSignal;
  budget?: BudgetTracker;
  /** Normally absent: the limiter is created at the first 429. A caller or test may pass one that then throttles from the start. */
  limiter?: AdaptiveRateLimiter;
  /** The spec's split class (E46): decides what a request that produced no reply does to the result. */
  split: SplitClass;
  /** The spec's `validation`; the caller owns it, there is no default. */
  policy: ValidationPolicy;
  /** Per ORIGINAL question key: the default label of a chunked choice (the spec's --default). Pass an entry only when the user gave one; the default is otherwise the last label of the question's criteria (plan §5). A label that is not one of the question's fails before any request is sent. */
  defaultLabels?: Record<string, string>;
  exec: (request: PlannedRequest<U>, deadline: Deadline) => Promise<ExecReply>;
}

/**
 * Failures that repeat identically for every request, so the run stops at the first one (owner ruling 2026-10-10: diagnose rapidly,
 * retry only what can heal): a bad key, no credits, a key limit, an unknown model, and the in-flight budget (the transport has already
 * spent its retries on it, so it is a credit wall, not a rate limit).
 * The others are NOT here: rate-limited heals by pacing; unavailable is transient; context-overflow, too-large and bad-request come from
 * that request's own body; bad-response, timeout and network concern that one exchange.
 */
export const FATAL_CLASSES: readonly ErrorClass[] = ["auth", "payment", "key-limit", "not-found", "in-flight-budget"];

/** WHY a subclass: a reply that was billed and then refused (bad answers) is in the usage history, so the printed usage and cost must include it; every ClassifierError rule of the fan-out still applies to it. */
export class BilledClassifierError extends ClassifierError {
  constructor(original: ClassifierError, readonly billed: EnvelopeReply) {
    super({ class: original.class, message: original.message, status: original.status, limit_source: original.limit_source, reason: original.reason, provider_code: original.provider_code, remedy_hint: original.remedy_hint, retryable: original.retryable });
    // WHY copied: the chain to the real error (an unclassified one's `cause`) must not be cut by the wrapper.
    this.cause = original.cause;
  }
}

/** A request that produced no reply. "error": it failed on its own. "fatal": not finished because another request hit a run-wide failure. */
export interface RequestFailure {
  requestIndex: number;
  kind: "error" | "aborted" | "budget" | "stopped" | "fatal";
  message: string;
  error?: ClassifierError;
}

/** The run-wide failure that stopped the run, reported once with the transport's own message and remedy. */
export interface FatalFailure {
  /** The original error, so a caller maps it to an exit code without rebuilding one. */
  error: ClassifierError;
  requestIndex: number;
  class: ErrorClass;
  message: string;
  remedy_hint?: string;
  status?: number;
}

export interface MergedReply {
  /** "failed": a run-wide failure (`fatal`), or a whole-result spec with a request that has no reply. "partial": a per-item spec with such a request. */
  status: "complete" | "partial" | "failed";
  /** Validated answers by question key. A question whose request has no reply is Invalid with a reason that starts with the failure kind. Empty for a whole-result spec that failed. */
  answers: Answers;
  /** Per original question key of a chunked item: chunks, best_chunk and best_lines of the merge (L2-19). Absent for unchunked items, so Answers keeps its shape. */
  chunks: Record<string, ChunkMeta>;
  /** Every billed reply, in plan order, for buildEnvelope. */
  replies: EnvelopeReply[];
  /** Every distinct served build, first seen first (E47). */
  snapshots: string[];
  warnings: Warning[];
  failures: RequestFailure[];
  fatal: FatalFailure | null;
  stopped: "budget" | "timeout" | null;
  /** True when the CALLER's signal (Ctrl-C) fired. */
  aborted: boolean;
  /** Question key (chunks folded under the item key) -> the model(s) that answered it; see ResultEnvelope.answered_by. */
  answeredBy: Record<string, string>;
}

/** The result of a run that sent nothing (a build that declares noCall, E65): complete, no answers, no replies. WHY here: one literal next to the type, so a new MergedReply field cannot be forgotten in a hand-written copy. */
export function emptyMerged(): MergedReply {
  return { status: "complete", answers: {}, chunks: {}, replies: [], snapshots: [], warnings: [], failures: [], fatal: null, stopped: null, aborted: false, answeredBy: {} };
}

/**
 * An error of `exec` that is not a ClassifierError (a TypeError in a parser, a disk error in the usage record), as that one request's failure.
 * WHY not rethrown as a bug: rethrowing rejected the whole run and threw away the answers and the cost of the other requests, which were already paid for. The original is kept as `cause`.
 * Exit code 5 (class bad-response): the request failed on its own and was not served usefully.
 */
export function unclassifiedError(e: unknown): ClassifierError {
  const text = e instanceof Error ? e.message : String(e);
  // WHY the error name in the message: a programming error (TypeError ...) must stay findable from the failure line alone.
  const name = e instanceof Error ? e.name : typeof e;
  const err = new ClassifierError({ class: "bad-response", message: `internal error in this request (${name}): ${text}`, reason: text, retryable: false });
  err.cause = e;
  return err;
}


/**
 * Any error of a request as a ClassifierError. WHY a deadline expiry keeps its own class: DeadlineError("timeout") is the request's time running out (exit 5, class timeout), not a bug; only the rest is wrapped by unclassifiedError.
 * A DeadlineError("aborted") needs no mapping: runCancellable records an aborted request as "aborted" whatever the error was.
 */
export function asClassifierError(e: unknown): ClassifierError {
  if (e instanceof ClassifierError) return e;
  if (e instanceof DeadlineError && e.reason === "timeout") return timeoutError();
  return unclassifiedError(e);
}

/** Where a merged chunked item came from (plan §5): how many chunks it had and which one, and which source lines, decided it. */
export interface ChunkMeta { chunks: number; best_chunk: number; best_lines?: [number, number] }

// Question keys of chunked units are `key#cN` (planner.ts); their validated answers are folded into ONE answer under `key`, so a spec's project sees its own keys.
// Why the default label is resolved before any request: mergeChunks needs it for a choice, and a wrong --default must fail before money is spent.
function chunkDefaults<U extends BuiltUnit>(plan: Plan<U>, defaultLabels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of plan.requests) for (const u of r.units) {
    const info = chunkOf(u);
    if (info === undefined) continue;
    for (const [ck, key] of Object.entries(info.keys)) {
      const q = u.questions[ck]!;
      if (q.type === "choice") out[key] = defaultLabel(Object.keys(q.criteria), defaultLabels[key]);
    }
  }
  return out;
}

function mergeChunkAnswers<U extends BuiltUnit>(plan: Plan<U>, answers: Answers, defaults: Record<string, string>): Record<string, ChunkMeta> {
  const groups = new Map<string, { index: number; from?: number; to?: number; count: number; answer: Answers[string] | undefined }[]>();
  for (const r of plan.requests) for (const u of r.units) {
    const info = chunkOf(u);
    if (info === undefined) continue;
    for (const [ck, key] of Object.entries(info.keys)) {
      groups.set(key, [...(groups.get(key) ?? []), { index: info.index, from: info.from, to: info.to, count: info.count, answer: answers[ck] }]);
      delete answers[ck];
    }
  }
  const meta: Record<string, ChunkMeta> = {};
  for (const [key, parts] of groups) {
    const valid = parts.filter((p): p is typeof p & { answer: { ok: true; answer: unknown } } => p.answer?.ok === true);
    if (valid.length === 0) {
      const first = parts.find((p) => p.answer?.ok === false)?.answer as { reason: string } | undefined;
      answers[key] = { ok: false, reason: `${first?.reason ?? "no reply"} (all ${parts.length} chunks invalid)` };
      continue;
    }
    const m = mergeChunks(valid.map((p) => ({ answer: p.answer.answer as ChunkAnswer, ...(p.from === undefined ? {} : { from: p.from, to: p.to }) })), defaults[key]);
    answers[key] = { ok: true, answer: m.answer };
    meta[key] = { chunks: parts[0]!.count, best_chunk: valid[m.best_chunk - 1]!.index, ...(m.best_lines === undefined ? {} : { best_lines: m.best_lines }) };
  }
  return meta;
}

// WHY a prefix per kind (owner ruling): "invalid_response" means the request failed on its own; a question that was never sent or was cut must say so.
const REASON_PREFIX: Record<RequestFailure["kind"], string> = { error: "invalid_response", aborted: "aborted", budget: "not_sent_budget", stopped: "not_sent_timeout", fatal: "not_sent_fatal" };

type Slot<U extends BuiltUnit> = { reply: ExecReply; request: PlannedRequest<U> } | { budgetStop: true } | { commandStop: true };

/**
 * Fan-out over runCancellable (L2-18) with an AdaptiveRateLimiter, not rateLimitedParallel: that runner awaits
 * Promise.all over its tasks, so one throwing request would discard the usage of the finished ones (E53), and it has
 * no per-request deadline or abort. Its limiter class is the one used here, so there is still only one limiter (E48).
 */
export async function runPlan<U extends BuiltUnit>(plan: Plan<U>, opts: RunPlanOptions<U>): Promise<MergedReply> {
  // WHY lazy (owner ruling "ultrafast"): the limiter starts full at rps = concurrency and refills at that rate, so 20 instant replies at concurrency 8 would wait ~1.5 s for nothing. E48 asks for a pause only after a 429.
  const defaults = chunkDefaults(plan, opts.defaultLabels ?? {});
  let limiter = opts.limiter;
  // WHY an epoch: N concurrent chunks that all get a 429 are ONE burst; halving N times would collapse 8 rps to 1 (E48). A request that started before the last halving must not halve again.
  let epoch = 0;
  let fatal: FatalFailure | null = null;
  // WHY the ONLY source of a lost bill: a reply billed and then refused, aborted or fatal is no outcome of its own, so it is recorded here by request and pushed once per request below, whatever branch the outcome takes.
  const billedByRequest = new Map<number, EnvelopeReply>();
  // WHY an own controller: stopping the run on a fatal failure must not abort the caller's signal; it follows the caller's.
  const stop = new AbortController();
  const onCallerAbort = (): void => stop.abort(opts.signal!.reason);
  if (opts.signal?.aborted) onCallerAbort();
  else opts.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const { outcomes } = await runCancellable(plan.requests, {
      concurrency: opts.concurrency,
      timeoutMs: opts.timeoutMs,
      signal: stop.signal,
      worker: async (request, index, deadline): Promise<Slot<U>> => {
        await limiter?.acquire();
        // WHY here, after the wait: the spend may have passed the cap while this request waited for a token (E86).
        if (opts.budget?.exceeded()) return { budgetStop: true };
        // --command_timeout (spec 15; review of 4856f009, finding 4): once the command is stopping, no new request is
        // sent, like every other request path; the finished answers are kept as a partial result.
        if (commandStopReason() !== null) return { commandStop: true };
        const started = epoch;
        let reply: ExecReply;
        try {
          reply = await opts.exec(request, deadline);
        } catch (e) {
          // The transport refuses a send or a retry once the command is stopping: not sent, not this request's failure.
          if (e instanceof CommandStoppedError) return { commandStop: true };
          // WHY: a billed but refused reply spent money, so it counts against --max-budget like any other.
          if (e instanceof BilledClassifierError) {
            opts.budget?.add(e.billed.cost.costUsd);
            billedByRequest.set(index, e.billed);
          }
          if (e instanceof ClassifierError && e.class === "rate-limited" && started === epoch) {
            epoch++;
            limiter ??= new AdaptiveRateLimiter(opts.concurrency);
            limiter.onRateLimit();
          }
          if (e instanceof ClassifierError && FATAL_CLASSES.includes(e.class) && fatal === null) {
            fatal = { error: e, requestIndex: index, class: e.class, message: e.message, remedy_hint: e.remedy_hint, status: e.status };
            stop.abort(e);
          }
          throw e;
        }
        limiter?.onSuccess();
        opts.budget?.add(reply.cost.costUsd);
        return { reply, request };
      },
  }).finally(() => opts.signal?.removeEventListener("abort", onCallerAbort));

  const answers: Answers = {};
  const answeredBy: Record<string, string> = {};
  const replies: EnvelopeReply[] = [];
  const failures: RequestFailure[] = [];
  const warnings: Warning[] = [];
  const fail = (f: RequestFailure): void => {
    failures.push(f);
    // WHY per-item only (E46): its units are independent, so the other requests' answers stay valid. A whole-result spec cannot project from a part, so it fails below.
    if (opts.split === "per-item") {
      for (const key of Object.keys(plan.requests[f.requestIndex]!.questions)) answers[key] = { ok: false, reason: `${REASON_PREFIX[f.kind]}: ${f.message}` };
    }
  };
  outcomes.forEach((o, requestIndex) => {
    const lostBill = billedByRequest.get(requestIndex);
    if (lostBill !== undefined) replies.push(lostBill);
    if (fatal !== null && requestIndex === fatal.requestIndex) {
      // WHY first: the abort it raised made its own deadline read "aborted", but this is the request that failed, and it failed on its own.
      fail({ requestIndex, kind: "error", message: fatal.message });
    } else if (o.status === "failed") {
      // WHY every error is this request's failure: an unclassified one (a bug in exec) is wrapped, so the other requests' answers, the replies and the cost survive it.
      const error = asClassifierError(o.error);
      fail({ requestIndex, kind: "error", message: error.message, error });
    } else if (o.status === "aborted" || o.status === "skipped") {
      // WHY fatal wins: the run aborted itself, so what it cut was not cut by Ctrl-C.
      if (fatal !== null) fail({ requestIndex, kind: "fatal", message: `the run stopped after a ${fatal.class} failure on request ${fatal.requestIndex}` });
      else fail({ requestIndex, kind: "aborted", message: "the run was aborted" });
    } else if ("commandStop" in o.value) {
      fail({ requestIndex, kind: "stopped", message: commandStopReason() ?? "--command_timeout stopped the run" });
    } else if ("budgetStop" in o.value) {
      fail({ requestIndex, kind: "budget", message: "--max-budget was passed before this request was sent" });
    } else {
      const { reply, request } = o.value;
      replies.push({ model: reply.model, usage: reply.usage, cost: reply.cost });
      const set = validateAnswers(request.questions, reply.answers, opts.policy);
      // WHY plain assign: question keys are unique across the job (E28, enforced by the planner), so no request can overwrite another's.
      Object.assign(answers, set.answers);
      // WHY per question, chunks folded under the item key: a fallback can switch the model mid-run, and the reader must see which model answered which item (TRDD-28BAL5ER).
      for (const qk of Object.keys(request.questions)) {
        const itemKey = qk.replace(/#c\d+$/, "");
        const seen = answeredBy[itemKey]?.split(", ") ?? [];
        if (!seen.includes(reply.model)) answeredBy[itemKey] = [...seen, reply.model].join(", ");
      }
      // WHY one warning per request: the keys name which request's model answered something nobody asked (plan §6: ignored and logged).
      if (set.extra.length > 0) warnings.push(warning("extra-answer-keys", `request ${requestIndex} answered keys it did not ask for, ignored: ${set.extra.join(", ")}`, set.extra.length));
    }
  });

  // WHY after every failure is recorded: a chunk whose request failed is already an Invalid entry under its chunk key, and merging treats it like any invalid chunk.
  const chunks = mergeChunkAnswers(plan, answers, defaults);
  const snapshots = [...new Set(replies.map((r) => r.model))];
  // E47: the alias moved to a new build mid-run; the results are still kept, the reader is told.
  if (snapshots.length > 1) warnings.push(warning("snapshot-changed", `the served model changed during the run: ${snapshots.join(", ")}`, snapshots.length));
  // WHY from the skipped requests, not budget.stopped(): a last request that crosses the cap ended nothing, so the run is not "stopped".
  // WHY from the skipped requests, not budget.stopped(): a last request that crosses the cap ended nothing, so the run is not "stopped".
  const notSent = failures.filter((f) => f.kind === "budget").length;
  const notSentStop = failures.filter((f) => f.kind === "stopped").length;
  // WHY budget first: either stop leaves the same partial result; the cap the user set is named before the timeout.
  const stopped = notSent > 0 ? "budget" : notSentStop > 0 ? "timeout" : null;
  // WHY the numbers: requests already in flight can overshoot the cap, so the reader sees what was spent and what was never sent.
  if (opts.budget && notSent > 0) warnings.push(warning("budget-stop", `--max-budget stopped the run: ${notSent} of ${plan.requests.length} requests not sent, ${opts.budget.spent()} USD spent`, notSent));
  if (notSentStop > 0) warnings.push(warning("command-timeout-stop", `--command_timeout stopped the run: ${notSentStop} of ${plan.requests.length} requests not sent; the answers already received are kept`, notSentStop));
  const status = fatal !== null || (failures.length > 0 && opts.split === "whole-result") ? "failed" : failures.length > 0 ? "partial" : "complete";
  // WHY the replies stay when failed: every billed reply is counted in usage and cost, whatever happens to the answers.
  const dropped = status === "failed" && opts.split === "whole-result";
  return { status, answers: dropped ? {} : answers, chunks: dropped ? {} : chunks, replies, snapshots, warnings, failures, fatal, stopped, aborted: opts.signal?.aborted ?? false, answeredBy: dropped ? {} : answeredBy };
}
