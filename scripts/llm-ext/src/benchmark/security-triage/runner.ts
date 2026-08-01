/**
 * Security-triage benchmark runner (TRDD-973a0265 §3.3).
 *
 * Scores ONE model over the golden dataset by driving the EXACT security_scan
 * judge pipeline (`judgeGroups`): the same injection-hardened prompt, the same
 * strict json_schema, the same clamp + fail-safe. The benchmark therefore
 * measures the model's judgment as the tool will actually use it — not an ad-hoc
 * prompt. Building groups directly (one per case) is the only deviation from the
 * full tool flow; intake's redaction/dedup is a content-prep step that does not
 * affect the MODEL-quality measurement (the dataset carries no secrets).
 *
 * Like the keyword runner, this never throws on a model/API failure — the judge
 * fail-safes every unrecoverable call to a verdict, so a bad model simply scores
 * poorly rather than aborting the sweep.
 */

import {
  judgeGroups,
  type FetchImpl,
  type JudgeOptions,
} from "../../security_scan/judge.js";
import type { DedupGroup } from "../../security_scan/intake.js";
import { realFetch } from "../../security_scan/openrouter.js";
import type { Verdict, VerdictPayload } from "../../security_scan/types.js";
import type { ModelPricing } from "../../mass_scouting/cost-estimate.js";

import { BENCHMARK_RUBRICS, type SecurityTriageCase } from "./dataset.js";

export interface TriageRunOptions {
  apiKey: string;
  pricing: ModelPricing;
  apiUrl?: string;
  /** Concurrent judge calls. Default 8 (matches the tool default). */
  workers?: number;
  /** Per-call validation retries. Default 1 (matches the tool default). */
  maxRetries?: number;
  /** Per-call timeout. Default 600_000ms. */
  perCallTimeoutMs?: number;
  /**
   * Category rubrics placed in the SYSTEM prompt. Default BENCHMARK_RUBRICS so
   * the benchmark measures the tool's canonical guidance.
   */
  rubrics?: Record<string, string>;
  onProgress?: (done: number, total: number) => void;
}

export interface TriageRunResult {
  modelId: string;
  /** case id → final verdict (post clamp / fail-safe). */
  verdicts: Map<string, Verdict>;
  /** case id → full payload (verdict + confidence + reason + injection_observed). */
  payloads: Map<string, VerdictPayload>;
  /** case id → the injection markers the pre-scan flagged. */
  markers: Map<string, string[]>;
  /**
   * case id → true when the verdict came from the FAIL-SAFE path (API error,
   * timeout, circuit trip, malformed reply) rather than a real model judgment.
   * The scorer EXCLUDES these so a degraded network/provider can't falsely fail
   * a model — a fail-safe `uncertain` is infrastructure noise, not a verdict.
   */
  failSafe: Map<string, boolean>;
  costUsd: number;
  groupsOk: number;
  groupsFailSafe: number;
  circuitTripped: boolean;
}

/**
 * Build one DedupGroup per case. The case id IS the group key (the loader
 * guarantees unique ids), so the verdict maps back unambiguously.
 */
export function casesToGroups(cases: readonly SecurityTriageCase[]): DedupGroup[] {
  return cases.map((c) => ({
    key: c.id,
    category: c.category,
    language: c.language,
    content: c.snippet,
    members: [
      {
        id: c.id,
        category: c.category,
        language: c.language,
        content: c.snippet,
      },
    ],
  }));
}

export async function runTriageBenchmarkOnModel(
  modelId: string,
  cases: readonly SecurityTriageCase[],
  opts: TriageRunOptions,
  fetchImpl: FetchImpl = realFetch,
): Promise<TriageRunResult> {
  const groups = casesToGroups(cases);

  const judgeOpts: JudgeOptions = {
    model: modelId,
    apiKey: opts.apiKey,
    pricing: opts.pricing,
    apiUrl: opts.apiUrl,
    workers: opts.workers ?? 8,
    maxRetries: opts.maxRetries ?? 1,
    perCallTimeoutMs: opts.perCallTimeoutMs ?? 600_000,
    // Disabled: the benchmark must attempt EVERY case so the score reflects the
    // full dataset. Per-case errors still fail-safe to a verdict inside the
    // judge; we just don't want a transient streak to skip the remainder.
    consecutiveFailureLimit: 0,
    defaultVerdictOnError: "uncertain",
    rubrics: opts.rubrics ?? BENCHMARK_RUBRICS,
    onProgress: opts.onProgress,
  };

  const result = await judgeGroups(groups, judgeOpts, fetchImpl);

  const verdicts = new Map<string, Verdict>();
  const payloads = new Map<string, VerdictPayload>();
  const markers = new Map<string, string[]>();
  const failSafe = new Map<string, boolean>();
  for (const gv of result.verdicts) {
    verdicts.set(gv.key, gv.payload.verdict);
    payloads.set(gv.key, gv.payload);
    markers.set(gv.key, gv.injectionMarkers);
    failSafe.set(gv.key, gv.failSafe);
  }

  return {
    modelId,
    verdicts,
    payloads,
    markers,
    failSafe,
    costUsd: result.costUsd,
    groupsOk: result.groupsOk,
    groupsFailSafe: result.groupsFailSafe,
    circuitTripped: result.circuitTripped,
  };
}
