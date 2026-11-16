// C4-08 (TRDD-BH78CSJO): the text and JSON forms of `classify <action> --estimate`; a leaf module so run-decision.ts (over 300 lines) only builds the numbers.
// WHY "estimate", not "ceiling": the number is estimateTokens over the planned request bodies plus the 64-token envelope, times the model prompt price. The O4MSZIG5 capture (14 specs, reports/release/20261031_120631+0100-O4MSZIG5.md) measured it up to 55% UNDER the API input tokens on small requests, and reply tokens are not counted (the catalog prices completion at zero, l2/cost-cap.ts), so it bounds nothing from above.

export interface EstimateReport {
  command: string;
  /** Requests the plan would send; 0 for a decision answered without a model (E65). */
  requests: number;
  inputTokens: number;
  /** The effective model id; null when no model is involved. */
  model: string | null;
  promptUsdPerMillion: number | null;
  /** null when the catalog has no prompt price, or when no model is involved the cost is 0. */
  estimatedInputCostUsd: number | null;
  /** TRDD-1L9VMEY7: true when the profile is local-only (the mlx-decision decider on this machine): free, no key, nothing remote. */
  local: boolean;
}

/** Builds the report. WHY one formula with checkEstimate (l2/cost-cap.ts): --max-budget refuses on the same number the user is shown. */
export function buildEstimate(command: string, requestTokens: readonly number[], model: { id: string; promptUsdPerM: number | null } | null, local = false): EstimateReport {
  const inputTokens = requestTokens.reduce((n, t) => n + t, 0);
  if (model === null) return { command, requests: 0, inputTokens: 0, model: null, promptUsdPerMillion: null, estimatedInputCostUsd: 0, local };
  return { command, requests: requestTokens.length, inputTokens, model: model.id, promptUsdPerMillion: model.promptUsdPerM, estimatedInputCostUsd: model.promptUsdPerM === null ? null : (inputTokens * model.promptUsdPerM) / 1_000_000, local };
}

export function renderEstimateText(e: EstimateReport): string {
  const lines = [`${e.command} --estimate: nothing was sent`];
  if (e.model === null) {
    lines.push("requests: 0 (this input is answered without a model)", "estimated input cost: 0 USD");
  } else {
    lines.push(
      `model: ${e.model}`,
      `requests: ${e.requests}`,
      `estimated input tokens: ${e.inputTokens}`,
      // TRDD-1L9VMEY7: a local-only profile is priced by no catalog: the call is local and free, and the line says so instead of a price.
      e.local ? "estimated input cost: 0 USD (local: the mlx-decision decider on this machine, free, no API key, nothing sent to OpenRouter)" : e.estimatedInputCostUsd === null ? `estimated input cost: unknown (the catalog has no prompt price for ${e.model})` : `estimated input cost: ${e.estimatedInputCostUsd.toFixed(6)} USD (${e.promptUsdPerMillion} USD per million tokens)`,
      "This is an estimate, not a ceiling: it counts input tokens only, and small requests have measured up to 55% below the tokens the API reports.",
    );
  }
  return lines.join("\n");
}

export function renderEstimateJson(e: EstimateReport): string {
  return JSON.stringify({ estimate: { command: e.command, requests: e.requests, input_tokens: e.inputTokens, model: e.model, prompt_usd_per_million: e.promptUsdPerMillion, estimated_input_cost_usd: e.estimatedInputCostUsd, ...(e.local ? { local: true } : {}) } }, null, 2);
}
