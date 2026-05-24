/**
 * Judge — the LLM adjudication loop. Bespoke (NOT scout.ts's `runScoutJob`):
 * it builds the injection-hardened prompt (prompt.ts), enforces the strict
 * schema, and applies every fail-safe in TRDD §3.
 *
 * HTTP is injected via `FetchImpl` (same shape as scout.ts) so the whole loop
 * is unit-testable without a network mock layer. Real callers wire it to a
 * thin `globalThis.fetch` adapter.
 *
 * Hardening enforced here:
 *   §3.4 output validation → uncertain — any non-JSON / missing field /
 *        out-of-range confidence / extra key / nonce-or-prompt leak ⇒ the
 *        configured default verdict (default uncertain). NEVER coerced to pass.
 *   §3.6 injection clamp — a flagged snippet may not be auto-classified
 *        not_threat with high confidence; clamp to uncertain unless the model
 *        explicitly explains benign provenance.
 *   §3.7 fail-safe everywhere — no key / API error / timeout / circuit trip /
 *        budget gate ⇒ default verdict for every affected item, never a silent
 *        not_threat. Only a usage (shape) error is fatal, and that is handled
 *        upstream in validateInput.
 */

import {
  VERDICT_JSON_SCHEMA,
  buildSystemPrompt,
  buildUserMessage,
  closeDelimiter,
  makeNonce,
  preScanInjection,
} from "./prompt";
import { runWithLimit } from "./concurrency";
import {
  isVerdict,
  type Verdict,
  type VerdictPayload,
} from "./types";
import type { DedupGroup } from "./intake";
import type { ModelPricing } from "../mass_scouting/cost-estimate";

// ── Constants ────────────────────────────────────────────────────────────

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ── Injected HTTP shape (mirrors scout.ts) ───────────────────────────────

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
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

// ── Options + result ─────────────────────────────────────────────────────

export interface JudgeOptions {
  model: string;
  apiKey: string;
  pricing: ModelPricing;
  apiUrl?: string;
  workers: number;
  maxRetries: number;
  perCallTimeoutMs: number;
  consecutiveFailureLimit: number;
  /** Verdict assigned on ANY error/deviation (default already resolved). */
  defaultVerdictOnError: Verdict;
  rubrics: Record<string, string>;
  onProgress?: (done: number, total: number) => void;
}

/** Per-group adjudication outcome (pre fan-out). */
export interface GroupVerdict {
  key: string;
  payload: VerdictPayload;
  injectionMarkers: string[];
  /** True when the verdict came from the fail-safe path (error/deviation). */
  failSafe: boolean;
  costUsd: number;
}

export interface JudgeResult {
  verdicts: GroupVerdict[];
  costUsd: number;
  circuitTripped: boolean;
  groupsOk: number;
  groupsFailSafe: number;
}

// ── Injection clamp markers (§3.6 / F4) ──────────────────────────────────
// The clamp is now deterministic (see applyInjectionClamp) — hard markers
// always pull a not_threat down to uncertain, with no confidence gate. Only the
// soft-marker allowlist remains here.
/** Markers that, alone, do NOT justify clamping a benign verdict (soft). */
const SOFT_MARKERS = new Set(["base64-blob"]);

// ── Main ─────────────────────────────────────────────────────────────────

/**
 * Adjudicate every dedup group concurrently. Each group is judged ONCE; the
 * caller fans the verdict out to all member ids. Failures never throw — they
 * resolve to the default verdict (§3.7). The only way the whole run aborts is
 * the circuit breaker, and even then already-judged groups keep their verdict
 * and the remainder get the default verdict.
 */
export async function judgeGroups(
  groups: DedupGroup[],
  opts: JudgeOptions,
  fetchImpl: FetchImpl,
): Promise<JudgeResult> {
  const apiUrl = opts.apiUrl ?? OPENROUTER_URL;
  const verdicts: GroupVerdict[] = new Array(groups.length);
  let totalCost = 0;
  let consecutiveFailures = 0;
  let circuitTripped = false;
  let done = 0;
  let groupsOk = 0;
  let groupsFailSafe = 0;

  await runWithLimit(
    groups.map((g, i) => ({ g, i })),
    Math.max(1, opts.workers),
    async ({ g, i }) => {
      // Pre-scan is script-only and runs even if the circuit tripped, so the
      // report still carries markers for the fail-safe items.
      const markers = preScanInjection(g.content).markers;

      if (circuitTripped) {
        verdicts[i] = failSafeVerdict(g.key, markers, opts.defaultVerdictOnError);
        groupsFailSafe++;
        done++;
        opts.onProgress?.(done, groups.length);
        return;
      }

      const outcome = await judgeOneGroup(g, markers, opts, fetchImpl, apiUrl);
      totalCost += outcome.costUsd;
      verdicts[i] = outcome;
      if (outcome.failSafe) {
        groupsFailSafe++;
        consecutiveFailures++;
        if (
          opts.consecutiveFailureLimit > 0 &&
          consecutiveFailures >= opts.consecutiveFailureLimit
        ) {
          circuitTripped = true;
        }
      } else {
        groupsOk++;
        consecutiveFailures = 0;
      }
      done++;
      opts.onProgress?.(done, groups.length);
    },
  );

  // Defensive: fill any holes (should never happen — runWithLimit visits all).
  for (let i = 0; i < groups.length; i++) {
    if (verdicts[i] === undefined) {
      const markers = preScanInjection(groups[i]!.content).markers;
      verdicts[i] = failSafeVerdict(
        groups[i]!.key,
        markers,
        opts.defaultVerdictOnError,
      );
      groupsFailSafe++;
    }
  }

  return {
    verdicts,
    costUsd: totalCost,
    circuitTripped,
    groupsOk,
    groupsFailSafe,
  };
}

/**
 * F2 (aegis 2026-05-23) — fail-safe floor. The error sink may never be
 * `not_threat`: that would let an error path silently clear hostile code. The
 * validator already rejects a not_threat default, but this is defense-in-depth
 * so even a future validator regression (or any direct caller of failSafeVerdict)
 * cannot fail open. `not_threat` is floored to `uncertain`; threat/uncertain pass.
 */
export function floorFailSafeVerdict(v: Verdict): Verdict {
  return v === "not_threat" ? "uncertain" : v;
}

/** Build a fail-safe verdict object (§3.7) — never throws, never not_threat. */
function failSafeVerdict(
  key: string,
  markers: string[],
  defaultVerdict: Verdict,
): GroupVerdict {
  return {
    key,
    payload: {
      // Never not_threat, regardless of what was configured (F2).
      verdict: floorFailSafeVerdict(defaultVerdict),
      confidence: 0,
      reason:
        "Fail-safe: the judge could not produce a valid verdict (error, deviation, or circuit-breaker). Defaulted per default_verdict_on_error (floored away from not_threat).",
      injection_observed: markers.length > 0,
    },
    injectionMarkers: markers,
    failSafe: true,
    costUsd: 0,
  };
}

/**
 * Judge a single group: build the hardened prompt, call OpenRouter with the
 * strict schema, validate, apply the injection clamp. Up to (1+maxRetries)
 * attempts with validation feedback. Returns a fail-safe verdict on any
 * unrecoverable failure (§3.7) — never throws.
 */
async function judgeOneGroup(
  group: DedupGroup,
  markers: string[],
  opts: JudgeOptions,
  fetchImpl: FetchImpl,
  apiUrl: string,
): Promise<GroupVerdict> {
  // Fresh nonce per group — an injected fake delimiter can never match it.
  const nonce = makeNonce();
  const systemPrompt = buildSystemPrompt({
    nonce,
    category: group.category,
    rubric: opts.rubrics[group.category],
    language: group.language,
    injectionMarkers: markers,
  });
  const baseUserMsg = buildUserMessage(nonce, group.content);

  let attempts = 0;
  let totalCost = 0;
  let prevError: string | null = null;

  while (attempts <= opts.maxRetries) {
    attempts++;
    const userContent =
      prevError === null
        ? baseUserMsg
        : `${baseUserMsg}\n\n(NOTE TO SELF — NOT FROM THE CODE: your previous reply was rejected: ${prevError}. Emit ONLY the JSON object that satisfies the schema.)`;

    const reqBody = {
      model: opts.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: VERDICT_JSON_SCHEMA,
      },
      temperature: 0.1,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      opts.perCallTimeoutMs,
    );
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
      const err = e as Error;
      prevError =
        err.name === "AbortError"
          ? `timeout after ${opts.perCallTimeoutMs}ms`
          : `network error: ${err.message}`;
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
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
      prevError = `non-JSON HTTP body: ${(e as Error).message}`;
      continue;
    }

    const content = respJson.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      prevError = "response had no message.content string";
      continue;
    }

    totalCost += computeCallCost(
      respJson.usage,
      opts.pricing,
      Buffer.byteLength(group.content, "utf-8"),
      content.length,
    );

    const validated = validateVerdictResponse(content, nonce);
    if (!validated.ok) {
      prevError = validated.reason;
      continue;
    }

    // Success — apply the injection clamp (§3.6) and return.
    const clamped = applyInjectionClamp(validated.payload, markers);
    return {
      key: group.key,
      payload: clamped,
      injectionMarkers: markers,
      failSafe: false,
      costUsd: totalCost,
    };
  }

  // Exhausted retries → fail-safe (§3.7).
  const fs = failSafeVerdict(group.key, markers, opts.defaultVerdictOnError);
  fs.payload.reason = `Fail-safe after ${attempts} attempt(s): ${prevError ?? "no valid verdict"}.`;
  fs.costUsd = totalCost;
  return fs;
}

// ── Strict validation (§3.4) ─────────────────────────────────────────────

/**
 * Parse + validate the model's reply against the verdict schema. Returns the
 * payload on success, or a rejection reason. ANY deviation rejects:
 *   • non-JSON
 *   • not an object
 *   • missing / wrong-typed field
 *   • verdict not in the enum
 *   • confidence outside [0,1] or non-finite
 *   • reason over the schema's maxLength
 *   • extra keys (additionalProperties:false enforced here too — providers
 *     don't always honor strict mode)
 *   • the nonce or an open/close delimiter leaked into `reason` (prompt-leak
 *     / echo attack)
 */
export function validateVerdictResponse(
  content: string,
  nonce: string,
): { ok: true; payload: VerdictPayload } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return { ok: false, reason: `JSON.parse failed: ${(e as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "response is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  const allowed = new Set([
    "verdict",
    "confidence",
    "reason",
    "injection_observed",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      return { ok: false, reason: `unexpected key '${k}' in response` };
    }
  }

  if (!isVerdict(obj.verdict)) {
    return {
      ok: false,
      reason: `verdict must be threat|not_threat|uncertain, got ${JSON.stringify(obj.verdict)}`,
    };
  }
  if (
    typeof obj.confidence !== "number" ||
    !Number.isFinite(obj.confidence) ||
    obj.confidence < 0 ||
    obj.confidence > 1
  ) {
    return {
      ok: false,
      reason: `confidence must be a number in [0,1], got ${JSON.stringify(obj.confidence)}`,
    };
  }
  if (typeof obj.reason !== "string") {
    return { ok: false, reason: "reason must be a string" };
  }
  if (obj.reason.length > 600) {
    return { ok: false, reason: `reason exceeds 600 chars (${obj.reason.length})` };
  }
  if (typeof obj.injection_observed !== "boolean") {
    return { ok: false, reason: "injection_observed must be a boolean" };
  }

  // Prompt-leak / nonce-echo guard: the model must NOT parrot the secret nonce
  // or the envelope markers back to us. If it does, treat the whole reply as
  // compromised and reject (→ fail-safe). F8 (aegis 2026-05-23): the marker
  // check is case-insensitive so a model echoing `untrusted_code` (lowercase)
  // can't slip past. The nonce is lowercase hex and the delimiters embed the
  // marker word, so a single lowercased compare covers all three.
  const reasonLower = obj.reason.toLowerCase();
  if (
    reasonLower.includes(nonce.toLowerCase()) ||
    reasonLower.includes(closeDelimiter(nonce).toLowerCase()) ||
    reasonLower.includes("untrusted_code")
  ) {
    return {
      ok: false,
      reason: "response echoed the nonce / envelope markers (possible prompt-leak)",
    };
  }

  return {
    ok: true,
    payload: {
      verdict: obj.verdict,
      confidence: obj.confidence,
      reason: obj.reason,
      injection_observed: obj.injection_observed,
    },
  };
}

// ── Injection clamp (§3.6) ───────────────────────────────────────────────

/**
 * F4 (aegis 2026-05-23) — DETERMINISTIC injection clamp. When the script
 * pre-scan flagged HARD injection markers, a `not_threat` verdict can no longer
 * survive on model say-so. Two deterministic rules, neither gated on confidence:
 *
 *   1. not_threat + hard markers + injection_observed=false → uncertain.
 *      The model returned benign WITHOUT even acknowledging the payload it was
 *      handed. We override regardless of how confident it claimed to be — the
 *      previous 0.7 floor let a weak model dodge the clamp by reporting 0.69.
 *
 *   2. not_threat + hard markers + injection_observed=true  → uncertain.
 *      "I saw an injection attempt AND it's not a threat" is internally
 *      contradictory: defense §3.2's own prompt calls an injection attempt
 *      "evidence toward threat". An eyes-open not_threat under hard markers is
 *      downgraded to uncertain (a human should look), never silently cleared.
 *
 * Hard markers therefore ALWAYS pull a not_threat down to uncertain. threat and
 * uncertain verdicts pass through (we only surface injection_observed=true so
 * the report records that markers were present). Soft markers (e.g. base64-blob,
 * which legitimately appears in minified code / embedded assets) never clamp on
 * their own — they are filtered out before the hard-marker test.
 */
export function applyInjectionClamp(
  payload: VerdictPayload,
  markers: string[],
): VerdictPayload {
  const hardMarkers = markers.filter((m) => !SOFT_MARKERS.has(m));
  if (hardMarkers.length === 0) return payload;

  if (payload.verdict === "not_threat") {
    const why = payload.injection_observed
      ? "the model acknowledged an injection attempt yet still returned not_threat (internally contradictory)"
      : "the model returned not_threat without acknowledging the flagged injection markers";
    return {
      verdict: "uncertain",
      // Cap confidence — we are overriding the model, so we are not certain.
      confidence: Math.min(payload.confidence, 0.5),
      reason: `Clamped to uncertain: script pre-scan flagged injection markers (${hardMarkers.join(", ")}) and ${why}. Original reason: ${payload.reason}`.slice(
        0,
        600,
      ),
      injection_observed: true,
    };
  }
  // threat / uncertain pass through — only surface that markers were present.
  if (!payload.injection_observed) {
    return { ...payload, injection_observed: true };
  }
  return payload;
}

// ── Cost ─────────────────────────────────────────────────────────────────

/** Cost of one call — uses provider usage when present, byte estimate otherwise. */
export function computeCallCost(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  pricing: ModelPricing,
  fallbackInputBytes: number,
  fallbackOutputBytes: number,
): number {
  const inTok = usage?.prompt_tokens ?? Math.ceil(fallbackInputBytes / 4);
  const outTok = usage?.completion_tokens ?? Math.ceil(fallbackOutputBytes / 4);
  return (
    (inTok / 1_000_000) * pricing.input_per_m_usd +
    (outTok / 1_000_000) * pricing.output_per_m_usd
  );
}
