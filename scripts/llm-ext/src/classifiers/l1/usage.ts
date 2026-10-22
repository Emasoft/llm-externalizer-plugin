// Plan §3 L1-09, §7, D8, E12: one usage and cost record per billed decisions reply, written to the shared history log.
import { recordRequest } from "../../usage-history.js";
import type { DecisionsModel } from "../l0/catalog.js";
import type { DecisionsCall } from "../l0/transport.js";
import { resolveModel } from "../l0/model.js";
import type { ReplyUsage } from "../l0/response.js";

/** The USD cost of one billed reply, and whether it is the provider figure or an estimate. */
export interface ReplyCost {
  costUsd: number;
  /** true when the reply had no usage.cost and the figure is input tokens times the catalog prompt price (D8). */
  cost_estimated: boolean;
}

/**
 * USD cost of one billed reply. The usage.cost the reply carries wins. Without it, the cost is input tokens times
 * the catalog prompt price; output is free because the catalog prices completion at zero.
 */
export function replyCost(usage: ReplyUsage, promptUsdPerM: number | null): ReplyCost {
  if (usage.cost !== undefined) return { costUsd: usage.cost, cost_estimated: false };
  // WHY refuse: recording a missing price as zero would count a billed call as free and under-count spend (E12).
  if (promptUsdPerM === null) {
    throw new Error("cannot estimate the cost of a reply without usage.cost: the catalog has no prompt price for this model");
  }
  return { costUsd: (usage.input_tokens * promptUsdPerM) / 1_000_000, cost_estimated: true };
}

/**
 * Records one billed decisions reply in the global usage history, one line per web request. Call it from the
 * record callback of parseDecisionsReply: that callback runs before answer checks (plan §7), so a billed reply
 * that fails validation is still counted.
 */
export function recordDecisionsUsage(opts: {
  usage: ReplyUsage;
  model: string;
  catalog: DecisionsModel[];
  durationMs: number;
  endpoint: DecisionsCall["endpoint"];
}): ReplyCost {
  // WHY the effective entry: an alias is priced by its target (E17), never by the alias entry.
  const cost = replyCost(opts.usage, resolveModel(opts.model, opts.catalog).effective.promptUsdPerM);
  // WHY ok true: the callback runs only for a 200 reply with valid usage, so the request was served and billed; the later answer check does not change what was charged.
  // WHY no withUsageContext here: the dispatch chokepoint installs the invocation context once, so every request of one run shares one op-id; a context per call would split the run.
  // WHY the endpoint on the line: stats and readers tell decisions calls from chat completions by this field (L1-10).
  recordRequest({ ok: true, durationMs: opts.durationMs, costUsd: cost.costUsd, endpoint: opts.endpoint });
  return cost;
}
