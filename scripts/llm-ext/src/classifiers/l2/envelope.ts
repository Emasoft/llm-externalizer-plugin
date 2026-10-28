// Plan §3 L2-12, D8, D10, E86: the `schema: 1` result envelope every classify command prints and `-o` saves.
import type { ReplyUsage } from "../l0/response.js";
import type { ReplyCost } from "../l1/usage.js";
import type { DegradedRecord, Warning } from "./warnings.js";

/** One finished decisions reply: the served build (snapshot, plan §7), its usage, and its cost record from L1-09. */
export interface EnvelopeReply {
  model: string;
  usage: ReplyUsage;
  cost: ReplyCost;
}

export interface ResultEnvelope<R> {
  // WHY a literal 1: parsers branch on the schema number; a change of shape must bump it.
  schema: 1;
  /** The decision's projected result. */
  decision: R;
  /** Every distinct served build of the run, first-seen order (E47). */
  snapshots: string[];
  usage: { input_tokens: number; output_tokens: number };
  cost: { usd: number; cost_estimated: boolean };
  warnings: Warning[];
  // WHY records, not a boolean: D1 wants each fallback named (E96); empty array = not degraded.
  degraded: DegradedRecord[];
  /** "budget" when --max-budget ended the run (E86); null otherwise. */
  stopped: "budget" | null;
  /** Present only when a run was answered by a model other than the profile's (TRDD-28BAL5ER): question key -> the model that answered it, so a mid-run switch is visible per item. A chunked item lists each distinct model. */
  answered_by?: Record<string, string>;
}

export function buildEnvelope<R>(opts: {
  decision: R;
  replies: EnvelopeReply[];
  warnings: Warning[];
  degraded: DegradedRecord[];
  stopped: "budget" | null;
  answeredBy?: Record<string, string>;
}): ResultEnvelope<R> {
  const { replies } = opts;
  return {
    schema: 1,
    decision: opts.decision,
    snapshots: [...new Set(replies.map((r) => r.model))],
    usage: {
      input_tokens: replies.reduce((n, r) => n + r.usage.input_tokens, 0),
      output_tokens: replies.reduce((n, r) => n + r.usage.output_tokens, 0),
    },
    // WHY any: one estimated reply makes the summed figure partly an estimate (D8).
    cost: { usd: replies.reduce((n, r) => n + r.cost.costUsd, 0), cost_estimated: replies.some((r) => r.cost.cost_estimated) },
    warnings: opts.warnings,
    degraded: opts.degraded,
    // WHY always present: a parser must not have to tell a missing key from a clean run.
    stopped: opts.stopped,
    ...(opts.answeredBy === undefined ? {} : { answered_by: opts.answeredBy }),
  };
}

/** The one text for stdout and the `-o` report: D10 says they are the same JSON, so both call this. */
export function renderEnvelope(env: ResultEnvelope<unknown>): string {
  return JSON.stringify(env, null, 2) + "\n";
}
