/**
 * Mass-scouting scout phase — fans (file × compiled-schema) calls out to
 * OpenRouter, repairs + validates each response, persists to the registry.
 *
 * Test boundary: HTTP is injected via `FetchImpl`. Real callers wire it to
 * `globalThis.fetch`; tests inject a stub returning canned chat.completions
 * payloads. This keeps the file unit-testable without a network mock layer.
 *
 * Concurrency: a tiny inline worker pool (see `runWithLimit`) gates parallel
 * calls to `fetchImpl`. We avoid a `p-limit` dep — the semantics we need
 * are 25 lines of code and adding a dep means rebuild concerns on Node 25+.
 *
 * Resume idempotency: every result write is `INSERT INTO mass_scout_results`
 * — the (job_id, file_fingerprint) PK rejects duplicates. Caller can re-run
 * `runScoutJob` with the same `jobId` and it picks up where it left off.
 */

import type { ScoutFieldset, CompiledFieldset, FieldDef } from "./fieldset";
import { compileFieldset } from "./fieldset";
import type {
  ModelPricing,
} from "./cost-estimate";
import {
  bytesCapFromPct,
  checkBudget,
  DEFAULT_SCOUT_WORKERS,
  estimateJobCost,
} from "./cost-estimate";
import type { Registry, RegistryRow } from "./registry";
import { recordRequest } from "../usage-history";
import { assertFreeOnlyModel, getActiveFreeOnly } from "../config";

// ── Constants ──────────────────────────────────────────────────────────

export const OPENROUTER_URL =
  "https://openrouter.ai/api/v1/chat/completions";

/** Smoke-test sample size — blueprint §3.1 + TRDD §6 step 3. */
export const SMOKE_TEST_SAMPLE = 5;

// ── Types ──────────────────────────────────────────────────────────────

export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchImpl = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    /**
     * Optional AbortSignal — when supplied, the fetch is cancelled when
     * `signal.aborted` flips. Mocks can ignore it. The default real-fetch
     * adapter passes it through to `globalThis.fetch`.
     */
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface ScoutOpts {
  /** Stable job id (caller-decided). Re-running with the same id resumes. */
  jobId: string;
  fieldset: ScoutFieldset;
  pricing: ModelPricing;
  model: string;
  apiKey: string;
  apiUrl?: string;
  /** Default `DEFAULT_SCOUT_WORKERS` (16). Set 1 for tests. */
  workers?: number;
  /** Default 1 (= up to 2 attempts per file). */
  maxRetries?: number;
  /** Optional preclassifier bucket filter. */
  bucket?: string;
  /** Default true — first SMOKE_TEST_SAMPLE files run sequentially first. */
  smokeTest?: boolean;
  /**
   * Pre-flight budget cap (USD). Caller has typically already run
   * `mass_scout_estimate`; we re-run the same math here as a defense in
   * depth and refuse to start if est > budget. `null` / `undefined` =
   * no gate (matches the legacy behaviour).
   */
  budgetUsd?: number | null;
  /**
   * Pre-computed estimated cost (skip re-running estimateJobCost). Only
   * used when `budgetUsd` is set. If undefined, we re-estimate inline.
   */
  estCostUsd?: number;
  /**
   * Circuit-breaker — if N consecutive calls fail (HTTP 4xx/5xx OR
   * validation), abort the run instead of fanning out the rest. Default 5.
   * Set 0 to disable.
   */
  consecutiveFailureLimit?: number;
  /** Per-call HTTP timeout (ms). Default 90_000. */
  perCallTimeoutMs?: number;
  /** Default true — skip files already in mass_scout_results for this jobId. */
  resume?: boolean;
  /** Where the eligible files were originally rooted (recorded on the job). */
  sourceRoot: string;
  /** Override the default 40%-of-context cap. */
  maxContextPctScout?: number;
  /** Per-file completion callback (UI progress). */
  onProgress?: (done: number, total: number) => void;
}

export interface ScoutResult {
  jobId: string;
  filesTotal: number;
  filesOk: number;
  filesFailed: number;
  filesSkippedTooBig: number;
  retries: number;
  costUsd: number;
  /** True when the consecutive-failure circuit breaker aborted the run. */
  circuitTripped?: boolean;
}

interface SingleFileOk {
  ok: true;
  parsed: Record<string, unknown>;
  raw: string;
  attempts: number;
  repaired: 0 | 1;
  costUsd: number;
}

interface SingleFileErr {
  ok: false;
  error: string;
  attempts: number;
  costUsd: number;
}

type SingleFileResult = SingleFileOk | SingleFileErr;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Concatenate every string-valued field (string, enum, array_string,
 * array_enum) from `parsed` into one newline-separated blob. Feeds FTS5.
 * Boolean/numeric fields are queryable via `searchByJsonExtract` instead.
 */
export function buildSearchableText(
  parsed: Record<string, unknown>,
  fieldset: ScoutFieldset,
): string {
  const parts: string[] = [];
  for (const f of fieldset.fields) {
    const v = parsed[f.name];
    if (v == null) continue;
    if (f.type.kind === "string" || f.type.kind === "enum") {
      if (typeof v === "string") parts.push(v);
    } else if (
      f.type.kind === "array_string" ||
      f.type.kind === "array_enum"
    ) {
      if (Array.isArray(v)) {
        for (const item of v) if (typeof item === "string") parts.push(item);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Compute the per-call USD cost from OpenRouter's usage block (token-accurate)
 * with a graceful fallback to the byte-based estimate when the provider omits
 * usage (some response-healing passes drop it).
 */
export function computeCallCost(
  usage:
    | { prompt_tokens?: number; completion_tokens?: number }
    | undefined,
  pricing: ModelPricing,
  fallbackInputBytes: number,
  fallbackOutputBytes: number,
): number {
  const inTok =
    usage?.prompt_tokens ?? Math.ceil(fallbackInputBytes / 4);
  const outTok =
    usage?.completion_tokens ?? Math.ceil(fallbackOutputBytes / 4);
  return (
    (inTok / 1_000_000) * pricing.input_per_m_usd +
    (outTok / 1_000_000) * pricing.output_per_m_usd
  );
}

/**
 * Tiny worker-pool runner — N parallel workers pull from a shared index.
 * Replaces `p-limit` for our single use case (no scheduling, no abort, no
 * error propagation magic — failures inside `fn` are the caller's concern).
 */
export async function runWithLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const total = items.length;
  let idx = 0;
  const workerCount = Math.max(1, Math.min(limit, total));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async (): Promise<void> => {
        while (true) {
          const myIdx = idx++;
          if (myIdx >= total) break;
          await fn(items[myIdx]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

// ── Main entry point ───────────────────────────────────────────────────

export async function runScoutJob(
  reg: Registry,
  opts: ScoutOpts,
  fetchImpl: FetchImpl,
): Promise<ScoutResult> {
  // Airtight free_only cost-safety (TRDD-97ef8b63). The scout fan-out fetches
  // OpenRouter directly; under a free_only profile a non-':free' scout model
  // throws BEFORE any of the per-file requests fire. opts.model is constant for
  // the whole job, so one check here covers every fanned-out file call.
  assertFreeOnlyModel(getActiveFreeOnly(), "openrouter", opts.model);
  const compiled = compileFieldset(opts.fieldset);
  const workers = Math.max(1, opts.workers ?? DEFAULT_SCOUT_WORKERS);
  const maxRetries = opts.maxRetries ?? 1;
  const scoutPct = opts.maxContextPctScout ?? 0.4;
  const cap = bytesCapFromPct(opts.pricing.context_window, scoutPct);
  const apiUrl = opts.apiUrl ?? OPENROUTER_URL;
  const smokeTest = opts.smokeTest !== false;
  const resume = opts.resume !== false;
  const failureLimit = opts.consecutiveFailureLimit ?? 5;

  // 0. Pre-flight budget gate (TRDD §15 Q4). When --budget-usd is set,
  //    re-run estimateJobCost (or trust opts.estCostUsd if pre-computed)
  //    and refuse to start if over.
  if (opts.budgetUsd !== undefined && opts.budgetUsd !== null) {
    const promptOverhead = Buffer.byteLength(compiled.systemPrompt, "utf-8");
    const schemaOverhead = Buffer.byteLength(
      JSON.stringify(compiled.jsonSchema),
      "utf-8",
    );
    const estCost =
      opts.estCostUsd ??
      estimateJobCost(reg, {
        pricing: opts.pricing,
        prompt_overhead_bytes: promptOverhead,
        schema_overhead_bytes: schemaOverhead,
        expected_output_bytes: 200,
        bucket: opts.bucket,
        max_context_pct_scout: scoutPct,
      }).est_cost_usd;
    const gate = checkBudget(estCost, opts.budgetUsd);
    if (!gate.allowed) {
      throw new Error(
        `mass-scouting budget gate refused job: ${gate.reason ?? "over budget"}`,
      );
    }
  }

  // 1. Persist the job header up-front so failures during fan-out leave a
  //    durable record that something started.
  if (!reg.getJob(opts.jobId)) {
    reg.createJob({
      job_id: opts.jobId,
      fieldset_name: opts.fieldset.fieldset_name,
      fieldset_json: JSON.stringify(opts.fieldset),
      json_schema: JSON.stringify(compiled.jsonSchema),
      model: opts.model,
      workers,
      source_root: opts.sourceRoot,
      bucket_filter: opts.bucket ?? null,
    });
  }

  // 2. Enumerate eligible rows + apply scout-cap + resume filter.
  const allRows = reg.listEligible(
    opts.bucket !== undefined ? { bucket: opts.bucket } : {},
  );
  const sized = allRows.filter((r) => r.file_size_bytes <= cap);
  const skippedTooBig = allRows.length - sized.length;
  for (const row of allRows) {
    if (row.file_size_bytes > cap) {
      reg.recordSkipped({
        short_id: row.short_id,
        file_path: row.file_path,
        reason: `body_bytes ${row.file_size_bytes} > scout cap ${cap} (${(scoutPct * 100).toFixed(0)}% of context)`,
        phase: "scout",
        size_bytes: row.file_size_bytes,
        context_pct: row.file_size_bytes / (opts.pricing.context_window * 4),
      });
    }
  }

  const done = resume
    ? reg.existingFingerprintsForJob(opts.jobId)
    : new Set<string>();
  const todo = sized.filter((r) => !done.has(r.fingerprint));

  // 3. Track running totals — visible to onProgress + finalizeJob.
  let filesOk = done.size;
  let filesFailed = 0;
  let totalRetries = 0;
  let totalCost = 0;

  const reportProgress = (): void => {
    opts.onProgress?.(filesOk + filesFailed, sized.length);
  };

  const writeOk = (row: RegistryRow, r: SingleFileOk): void => {
    reg.insertResult({
      job_id: opts.jobId,
      file_fingerprint: row.fingerprint,
      short_id: row.short_id,
      result_json: JSON.stringify(r.parsed),
      raw_response: r.raw,
      repaired: r.repaired,
      attempts: r.attempts,
      cost_usd: r.costUsd,
      searchable_text: buildSearchableText(r.parsed, opts.fieldset),
    });
  };

  // 4. Smoke test on first SMOKE_TEST_SAMPLE files (sequential).
  if (smokeTest && todo.length > 0) {
    const probeCount = Math.min(SMOKE_TEST_SAMPLE, todo.length);
    for (let i = 0; i < probeCount; i++) {
      const row = todo[i]!;
      const r = await scoutOneFile(
        reg,
        row,
        compiled,
        opts,
        fetchImpl,
        apiUrl,
        maxRetries,
      );
      totalRetries += Math.max(0, r.attempts - 1);
      totalCost += r.costUsd;
      if (!r.ok) {
        // Smoke test failed — record the skipped row so the registry stays
        // consistent with the fan-out failure path, then finalize with what
        // we have and bail.
        reg.recordSkipped({
          short_id: row.short_id,
          file_path: row.file_path,
          reason: `scout smoke-test failed after ${r.attempts} attempt(s): ${r.error}`,
          phase: "scout",
          size_bytes: row.file_size_bytes,
        });
        reg.finalizeJob(opts.jobId, {
          files_total: allRows.length,
          files_ok: filesOk,
          files_failed: filesFailed + 1,
          retries: totalRetries,
          cost_usd: totalCost,
        });
        throw new Error(
          `mass-scouting smoke test failed on ${row.file_path}: ${r.error}`,
        );
      }
      writeOk(row, r);
      filesOk++;
      reportProgress();
    }
    todo.splice(0, probeCount);
  }

  // 5. Parallel fan-out for the remainder. SQLite writes happen inside the
  //    same single-threaded event loop, so no contention vs. better-sqlite3.
  // Circuit breaker: track CONSECUTIVE failures across workers. Once we
  // see `failureLimit` failures in a row (no success in between), abort
  // the rest of the fan-out — usually means the model/provider is broken
  // for this fieldset+content shape and we'd waste the budget.
  let consecutiveFailures = 0;
  let circuitTripped = false;
  await runWithLimit(todo, workers, async (row) => {
    if (circuitTripped) return;
    const r = await scoutOneFile(
      reg,
      row,
      compiled,
      opts,
      fetchImpl,
      apiUrl,
      maxRetries,
    );
    totalRetries += Math.max(0, r.attempts - 1);
    totalCost += r.costUsd;
    if (r.ok) {
      writeOk(row, r);
      filesOk++;
      consecutiveFailures = 0;
    } else {
      filesFailed++;
      consecutiveFailures++;
      reg.recordSkipped({
        short_id: row.short_id,
        file_path: row.file_path,
        reason: `scout failed after ${r.attempts} attempt(s): ${r.error}`,
        phase: "scout",
        size_bytes: row.file_size_bytes,
      });
      if (failureLimit > 0 && consecutiveFailures >= failureLimit) {
        circuitTripped = true;
      }
    }
    reportProgress();
  });

  // 6. Finalize.
  reg.finalizeJob(opts.jobId, {
    files_total: allRows.length,
    files_ok: filesOk,
    files_failed: filesFailed,
    retries: totalRetries,
    cost_usd: totalCost,
  });

  return {
    jobId: opts.jobId,
    filesTotal: allRows.length,
    filesOk,
    filesFailed,
    filesSkippedTooBig: skippedTooBig,
    retries: totalRetries,
    costUsd: totalCost,
    circuitTripped,
  };
}

// ── Per-file scout call ────────────────────────────────────────────────

/**
 * Make up to (1 + maxRetries) calls for one file. Each call:
 *   1. Build messages — system prompt + `userPromptFor(basename, body)`.
 *   2. Fire the request through `fetchImpl`.
 *   3. Parse `choices[0].message.content` as JSON.
 *   4. `repair()` (idempotent on valid input).
 *   5. `validate()` the repaired object.
 *   6. On failure, prepend the validate `reason` to the next user message
 *      (retry-with-feedback per blueprint §3.7).
 */
async function scoutOneFile(
  reg: Registry,
  row: RegistryRow,
  compiled: CompiledFieldset,
  opts: ScoutOpts,
  fetchImpl: FetchImpl,
  apiUrl: string,
  maxRetries: number,
): Promise<SingleFileResult> {
  const body = reg.readBody(row.fingerprint);
  if (!body) {
    return {
      ok: false,
      error: "no body cached in registry — cannot scout",
      attempts: 0,
      costUsd: 0,
    };
  }
  const bodyStr = body.toString("utf-8");
  const baseUserMsg = compiled.userPromptFor(row.basename, bodyStr);

  let attempts = 0;
  let totalCost = 0;
  let prevError: string | null = null;

  while (attempts <= maxRetries) {
    attempts++;
    const userContent =
      prevError === null
        ? baseUserMsg
        : `${baseUserMsg}\n\nPREVIOUS RESPONSE FAILED VALIDATION:\n${prevError}\n\nReturn a JSON object that satisfies the schema this time.`;
    const reqBody = {
      model: opts.model,
      messages: [
        { role: "system", content: compiled.systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: compiled.jsonSchema,
      },
      temperature: 0.1,
    };
    // Per-call timeout — defaults to 90s. Cancels the fetch via AbortSignal
    // so a hung provider can't stall the whole worker pool.
    const perCallMs = opts.perCallTimeoutMs ?? 90_000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), perCallMs);
    // One scout HTTP attempt = one usage-history line. Time each attempt so a
    // retry produces its own line with its own ok/duration/cost.
    const attemptStart = Date.now();
    let res: FetchResponse;
    try {
      res = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (e) {
      clearTimeout(timeoutId);
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      const err = e as Error;
      prevError =
        err.name === "AbortError"
          ? `timeout after ${perCallMs}ms`
          : `network error: ${err.message}`;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      prevError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      continue;
    }
    let respJson: {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      respJson = (await res.json()) as typeof respJson;
    } catch (e) {
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      prevError = `non-JSON response: ${(e as Error).message}`;
      continue;
    }
    const content = respJson.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      prevError = "response had no message.content string";
      continue;
    }
    const callCost = computeCallCost(
      respJson.usage,
      opts.pricing,
      bodyStr.length,
      content.length,
    );
    totalCost += callCost;
    // The HTTP request itself succeeded (a parseable, billed response came
    // back) — record it with this call's own cost, even if the content then
    // fails JSON.parse/validation below (a content issue, not a failed request).
    recordRequest({ ok: true, durationMs: Date.now() - attemptStart, costUsd: callCost });

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      prevError = `JSON.parse failed: ${(e as Error).message}`;
      continue;
    }
    const repairOutcome = compiled.repair(parsed);
    const validation = compiled.validate(repairOutcome.repaired);
    if (validation.ok) {
      return {
        ok: true,
        parsed: repairOutcome.repaired,
        raw: content,
        attempts,
        repaired: repairOutcome.repairs.length > 0 ? 1 : 0,
        costUsd: totalCost,
      };
    }
    prevError = validation.reason ?? "validate failed (no reason given)";
  }
  return {
    ok: false,
    error: prevError ?? "max retries exhausted",
    attempts,
    costUsd: totalCost,
  };
}

// Re-export FieldDef as the FieldDef-using callers may need it.
export type { FieldDef };
