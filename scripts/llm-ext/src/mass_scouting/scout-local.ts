/**
 * mass_scouting/scout-local.ts — mass scouting on a local profile (P9, TRDD-1OOAH3LD, TRDD-ZGSGGHQG).
 *
 * WHY a separate resolver instead of provider/connection.ts resolveConnection: that resolver needs the ProviderDeps
 * object index.ts builds and does not export (mass_scouting is outside that chain, config.ts billableForRoute
 * comment), and its openai_api branch probes the endpoint flavor and can answer a llama.cpp server with the native
 * `/api/v1/chat` URL, which the OpenAI-shaped scout body cannot drive. So the same three facts are derived here from
 * the resolved profile: the URL (`<url>/v1/chat/completions`), the auth header (Bearer of the profile's own token,
 * as index.ts apiHeaders does; never OPENROUTER_API_KEY), and the broker for a `server: managed` profile.
 *
 * Every local scout request is governed like an `llm ask` on the same profile: a managed profile's requests go to
 * the broker as jobs (brokerExchange, the path provider/completion.ts takes; the broker takes the lease), an
 * unmanaged one's go straight to the server under a direct lease (leasedResponse, governor design D9).
 *
 * The calibration record is the quality gate (local-calibration-design.md section 4.5): a model with a missing or
 * failed record, or unfit for scouting, is skipped for the next model of the profile (section 6, F3), and scoutingFor
 * at scout_accuracy_threshold picks the share, the slot count and the slot context. Requests carry the reply cap and
 * the thinking setting Phase C measured under.
 */

import { effectiveProfileName, getConfigDir, resolveProfile, scoutAccuracyThreshold, type Settings } from "../config";
import { readRecord, readRecordStatus, scoutingFor, type CalibrationRecord, type ScoutCandidate } from "../calibration/record.js";
import { SCOUT_OUTPUT_CAP, SCOUTING_THINKING } from "../calibration/phase-c.js";
import { localsOutgoingModel } from "../local-locals-server.js";
import type { BrokerEngine } from "../broker/protocol.js";
import { brokerClientVersion, brokerExchange, brokerQueueTimeoutMs, ensureBroker } from "../broker/client.js";
import { leasedResponse } from "../governor/direct";
import type { ModelPricing } from "./cost-estimate";
import type { FetchImpl, ScoutOpts } from "./scout";

/** The backstop expiry of a scouting request's direct lease: longer than any per-call timeout scouting sets. */
export const RAW_FETCH_LEASE_MS = 30 * 60_000;

/**
 * The plain fetch adapter with the governor's direct lease (design D9): a loopback target takes a lease to the end of
 * the body, released on every way out; a remote one never touches the governor.
 */
export const leasedFetch: FetchImpl = async (url, init) => {
  const res = await leasedResponse(url, RAW_FETCH_LEASE_MS, () => fetch(url, init), { signal: init.signal });
  return {
    ok: res.ok,
    status: res.status,
    json: () => res.json() as Promise<unknown>,
    text: () => res.text(),
  };
};

export interface LocalScoutPlan {
  profile: string;
  engine: BrokerEngine;
  model: string;
  /** True for `server: managed`: requests go to the broker as jobs. */
  managed: boolean;
  /** The chat-completions URL of an unmanaged server; a label for a managed one (the broker owns the port). */
  apiUrl: string;
  headers: Record<string, string>;
  /** The scouting shape scoutingFor chose at the current threshold. */
  candidate: ScoutCandidate;
  /** --workers capped at the candidate's slots; the slots when --workers is absent. */
  workers: number;
  /** The record's structured_output.array40: the response mode Phase C measured the scouting accuracy with. */
  structuredOutput: boolean;
  /**
   * SCOUT_OUTPUT_CAP, the reply size Phase C reserved inside slot_ctx (scoutSlotCtx = share + SCOUT_OUTPUT_CAP +
   * overhead, rounded up). Round 2: NOT slot_ctx - share_tokens, which also holds the overhead and the round-up, so a
   * full-share prompt with that max_tokens could pass slot_ctx.
   */
  maxTokens: number;
  /** SCOUTING_THINKING: the thinking setting Phase C measured the scouting accuracy under. */
  extraBody: Record<string, unknown>;
  charsPerToken: number;
  /** A local route never bills: price 0, the context is the scouting slot. */
  pricing: ModelPricing;
  fetchImpl: FetchImpl;
}

/** The two local apis whose servers calibration measures, and their engine (calibration records are per engine). */
const ENGINE_OF_API: Record<string, BrokerEngine> = { "llamacpp-local": "llama", "locals-local": "locals" };

/** scoutOneFile's default per-call timeout; on a managed plan it becomes the broker job's execution timeout. */
const DEFAULT_PER_CALL_MS = 90_000;

/** One model's calibration verdict for scouting: its record and chosen candidate, or why it cannot scout. */
type ModelVerdict = { fit: true; record: CalibrationRecord; candidate: ScoutCandidate } | { fit: false; why: string };

function judgeModel(dir: string, engine: BrokerEngine, model: string, threshold: number, log: (msg: string) => void): ModelVerdict {
  const status = readRecordStatus(dir, engine, model, log);
  if (status.state === "missing") {
    return { fit: false, why: `model '${model}' (${engine}) is not calibrated; run llm-ext models calibrate --model ${model}` };
  }
  if (status.state === "failed") return { fit: false, why: status.message };
  const record = readRecord(dir, engine, model, log);
  // readRecordStatus said ok, which it says only for a record readRecord accepts: null here is a defect, not "missing".
  if (record === null) throw new Error(`calibration record of '${model}' (${engine}) vanished between two reads`);
  if (record.scouting_unfit_reason !== undefined) {
    // Spec 4.5: no candidate could be scored, which must never read as an accuracy failure.
    return { fit: false, why: `model '${model}' is unfit for mass scouting: no scouting candidate could be measured (${record.scouting_unfit_reason}); llm-ext models calibration-status shows the record` };
  }
  const candidates = record.scouting_candidates ?? [];
  const pick = scoutingFor(candidates, threshold);
  if (pick === "unfit") {
    const best = candidates.length > 0 ? Math.max(...candidates.map((c) => c.accuracy)) : null;
    return {
      fit: false,
      why: `model '${model}' is unfit for mass scouting: its best measured scouting accuracy is ${best === null ? "none (no candidate measured)" : best} and the threshold (scout_accuracy_threshold) is ${threshold}`,
    };
  }
  return { fit: true, record, candidate: pick };
}

/**
 * The local scouting plan when the ACTIVE profile is a local llama.cpp or Locals profile, null otherwise (every
 * remote run is unchanged), or the refusal. `--profile` names a scouting-type profile, so an explicit one keeps the
 * remote scouting path.
 *
 * Model choice (spec 4.5 and section 6, F3): with --model, that model only, refused when it cannot scout. Without it,
 * the profile's models in order (model, second_model, third_model): the first fit one scouts, each one skipped is
 * named on stderr with why, and when none is fit the refusal names every model with its reason.
 */
export function resolveLocalScouting(flags: Record<string, string>, settings: Settings | null): LocalScoutPlan | { error: string } | null {
  if (!settings) return null;
  // Round 3: --profile naming a local llama.cpp or Locals profile scouts on THAT profile; any other --profile (a
  // scouting-type one) keeps the remote path, whose scoutingHead refuses a non-scouting profile.
  const name = flags["profile"] ?? effectiveProfileName(settings);
  const profile = settings.profiles?.[name];
  if (!profile || profile.mode !== "local") return null;
  const engine = ENGINE_OF_API[profile.api];
  if (engine === undefined) return null;
  const resolved = resolveProfile(name, profile);
  const dir = getConfigDir();
  const log = (msg: string): void => {
    process.stderr.write(`llm-ext: ${msg}\n`);
  };
  const threshold = scoutAccuracyThreshold(settings);
  const explicit = flags["model"];
  const order = explicit !== undefined ? [explicit] : [...new Set([resolved.model, resolved.secondModel, resolved.thirdModel].filter((m) => m !== ""))];
  const skipped: string[] = [];
  let chosen: { model: string; record: CalibrationRecord; candidate: ScoutCandidate } | null = null;
  for (const model of order) {
    const v = judgeModel(dir, engine, model, threshold, log);
    if (v.fit) {
      chosen = { model, record: v.record, candidate: v.candidate };
      break;
    }
    skipped.push(v.why);
  }
  if (chosen === null) {
    if (explicit !== undefined) return { error: skipped[0]! };
    return { error: `no model of profile '${name}' is fit for mass scouting: ${skipped.join("; ")}` };
  }
  for (const why of skipped) log(`mass scouting skips a model of profile '${name}': ${why}`);
  const { model, record, candidate: pick } = chosen;
  const workers = localWorkers(flags["workers"], pick.slots);
  if (typeof workers === "object") return workers;
  const managed = resolved.server !== null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (resolved.authToken) headers["Authorization"] = `Bearer ${resolved.authToken}`;
  const serverUrl = resolved.url.replace(/\/+$/, "");
  const apiUrl = managed ? `broker:${engine}` : `${serverUrl}/v1/chat/completions`;
  const perCall = flags["per-call-timeout-ms"] !== undefined ? Number(flags["per-call-timeout-ms"]) : DEFAULT_PER_CALL_MS;
  const fetchImpl = managed
    ? brokerFetch(engine, model, pick.slot_ctx, perCall)
    : engine === "locals"
      ? localsIdFetch(leasedFetch, serverUrl, headers)
      : leasedFetch;
  return {
    profile: name,
    engine,
    model,
    managed,
    apiUrl,
    headers,
    candidate: pick,
    workers,
    structuredOutput: record.structured_output?.array40 === true,
    maxTokens: SCOUT_OUTPUT_CAP,
    extraBody: { ...SCOUTING_THINKING },
    charsPerToken: record.chars_per_token ?? 4,
    pricing: { input_per_m_usd: 0, output_per_m_usd: 0, context_window: pick.slot_ctx },
    fetchImpl,
  };
}

/**
 * A FetchImpl that runs each request as a broker job, as provider/completion.ts does for a managed profile. The ctx
 * is the scouting slot context, so the broker serves scouting from a server of that shape (spec 4.5, F18).
 * Round 3: `timeoutMs` is the per-call timeout, which the broker counts from dispatch, so time queued or waiting for a
 * model load is not part of it (the queue has its own --queue_timeout); the client sets no timer of its own
 * (ScoutOpts.noClientTimeout), because one would abort a job still waiting for its turn.
 */
function brokerFetch(engine: BrokerEngine, model: string, ctx: number, timeoutMs: number): FetchImpl {
  const dir = getConfigDir();
  const version = brokerClientVersion();
  return async (_url, init) => {
    const ep = await ensureBroker({ dir, version });
    const res = await brokerExchange(
      ep,
      { engine, body: init.body, model, ctx, timeoutMs, queueTimeoutMs: brokerQueueTimeoutMs() },
      { signal: init.signal, reconnect: () => ensureBroker({ dir, version, fresh: true }) },
    );
    return { ok: res.ok, status: res.status, json: () => res.json() as Promise<unknown>, text: () => res.text() };
  };
}

/** The runScoutJob options a local plan sets (scout and chain share them, so the two cannot drift). */
export function localScoutOpts(plan: LocalScoutPlan): Pick<ScoutOpts, "apiUrl" | "headers" | "maxTokens" | "structuredOutput" | "inputBudget" | "extraBody" | "noClientTimeout"> {
  return {
    apiUrl: plan.apiUrl,
    headers: plan.headers,
    maxTokens: plan.maxTokens,
    structuredOutput: plan.structuredOutput,
    inputBudget: { tokens: plan.candidate.share_tokens, charsPerToken: plan.charsPerToken },
    extraBody: plan.extraBody,
    // A managed plan's broker bounds the call (brokerFetch), so the client sets no timer of its own.
    noClientTimeout: plan.managed,
  };
}

/**
 * Parallel requests on a local profile: --workers when given (a positive integer, else a usage error, never silently
 * the slot count), never more than the calibrated slot count.
 */
function localWorkers(flag: string | undefined, slots: number): number | { error: string } {
  if (flag === undefined) return slots;
  if (!/^[1-9][0-9]*$/.test(flag)) return { error: `--workers must be a positive integer, got '${flag}'` };
  return Math.min(Number(flag), slots);
}

/**
 * Round 3: on an UNMANAGED Locals profile, send the model id Phase C measured with. Locals lists `locals/<short>` and,
 * for a thinking model, `locals/<short>-thinking` on /v1/models; Phase C (and the broker for a managed profile,
 * broker/server.ts) set the body model to localsOutgoingModel(ids, body), which for the thinking-off body is the base
 * id. The ids are read once per command; a failed read fails the request (the server is not usable), never a guess.
 */
function localsIdFetch(base: FetchImpl, serverUrl: string, headers: Record<string, string>): FetchImpl {
  let ids: Promise<string[]> | null = null;
  const readIds = async (): Promise<string[]> => {
    const res = await fetch(`${serverUrl}/v1/models`, { headers });
    if (!res.ok) throw new Error(`GET ${serverUrl}/v1/models: HTTP ${res.status}`);
    const data = ((await res.json()) as { data?: Array<{ id?: unknown }> }).data ?? [];
    return data.map((d) => d.id).filter((id): id is string => typeof id === "string");
  };
  return async (url, init) => {
    ids ??= readIds();
    const parsed = JSON.parse(init.body) as Record<string, unknown>;
    const model = localsOutgoingModel(await ids, parsed) ?? parsed.model;
    return base(url, { ...init, body: JSON.stringify({ ...parsed, model }) });
  };
}
