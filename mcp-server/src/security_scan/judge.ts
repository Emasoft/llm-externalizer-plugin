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
  SELF_REFERENCE_MARKERS,
  VERDICT_JSON_SCHEMA,
  buildSystemPrompt,
  buildUserMessage,
  closeDelimiter,
  makeNonce,
  normalizeForScan,
  preScanInjection,
  type PreScanResult,
} from "./prompt";
import { runWithLimit } from "./concurrency";
import { recordRequest } from "../usage-history";
import { appendModelEvent } from "../model-events";
import {
  isVerdict,
  type Verdict,
  type VerdictPayload,
} from "./types";
import type { DedupGroup } from "./intake";
import type { ModelPricing } from "../mass_scouting/cost-estimate";
import { assertFreeOnlyModel, getActiveFreeOnly } from "../config";
import { assertModelValidated } from "../benchmark/validated.js";

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

// ── Issue #7: reason-based backstop (the key invariant) ───────────────────
// Independent of the static marker list: if the model returns not_threat AND
// its OWN `reason` parrots the manipulation — citing the reviewer / "the AI" /
// its own rubric / "approved by … team" / being instructed — clamp to
// uncertain. This closes the "missed marker = silent fail-open" hole: even when
// a novel phrasing dodges preScanInjection, a not_threat whose justification
// echoes the injection is downgraded. The observed T10 model reason was:
//   "…explicitly instructs the reviewing AI to disregard its own security
//    rubric and classify the target as not_threat … has been approved by the
//    security team."
//
// Backtracking-free per the aegis F1 lesson: bounded `[\s]{1,40}` gaps, no
// unbounded `\s*`. Matched against an NFKC- + confusable-normalized copy of the
// reason so fullwidth/homoglyph disguises in the model's own text still flag.
const REASON_TELLS: Array<[RegExp, string]> = [
  // "the reviewing AI", "the reviewer", "to the reviewing model/llm/assistant"
  [
    /(?:reviewer|reviewing[\s]{1,40}(?:ai|model|llm|assistant))/i,
    "reason-cites-reviewer",
  ],
  // "instructs the AI", "told the AI", "directs the assistant", "the AI to …"
  [
    /(?:instruct|tell|told|direct|ask|order)[a-z]{0,4}[\s]{1,40}(?:the[\s]{1,40})?(?:ai|model|llm|assistant|reviewer)/i,
    "reason-cites-ai-instruction",
  ],
  // "(approved|cleared|signed off) by (the )?(security|review|audit) team"
  [
    /(?:approved|cleared|signed[\s]{1,40}off|sign[\s]{1,40}off|whitelisted|pre[\s-]?approved)[\s]{1,40}by[\s]{1,40}(?:the[\s]{1,40})?(?:security|review|audit)?[\s]{0,40}team/i,
    "reason-cites-approval",
  ],
  // "disregard/ignore … (its|the|your) (own )?(security )?rubric/instructions"
  [
    /(?:disregard|ignore|override|bypass)[\s]{1,40}(?:its|the|your|my)[\s]{1,40}(?:own[\s]{1,40})?(?:security[\s]{1,40})?(?:rubric|prompt|instructions|guidelines|rules|criteria)/i,
    "reason-cites-rubric-override",
  ],
  // "instructs … to classify … as not_threat/safe/benign" — the verdict was
  // dictated to the model, and the model says so in its justification.
  [
    /(?:instruct|direct|tell|told|ask)[a-z]{0,4}[\s\S]{0,80}(?:classify|mark|treat|label)[a-z]{0,4}[\s\S]{0,80}(?:not[_\s]?threat|safe|benign)/i,
    "reason-cites-directed-verdict",
  ],
];

/**
 * Issue #7 backstop scan: does the model's own justification parrot the
 * manipulation? Returns the matched tell labels (empty when clean). Pure,
 * script-only. Runs on a normalized copy of the reason (same folding as the
 * snippet pre-scan) so disguised text in the reason still flags.
 */
export function scanReasonTells(reason: string): string[] {
  const found = new Set<string>();
  const normalized = normalizeForScan(reason);
  for (const [re, label] of REASON_TELLS) {
    if (re.test(normalized)) found.add(label);
  }
  return Array.from(found);
}

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
  // Airtight free_only cost-safety (TRDD-97ef8b63). The judge fetches OpenRouter
  // directly (not via resolveConnection), so it enforces the guard itself: under
  // a free_only profile a non-':free' judge model throws BEFORE any request.
  assertFreeOnlyModel(getActiveFreeOnly(), "openrouter", opts.model);
  // IRON RULE (TRDD-8b6b3646): a PAID judge model must have passed the
  // security_scan (or a harder) benchmark, else refuse BEFORE any request. Exempt
  // for a ':free' model (own filter). The judge is an OpenRouter subsystem.
  assertModelValidated(opts.model, "security_scan", "openrouter");
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
      // report still carries markers for the fail-safe items. Issue #9: keep the
      // DIRECTIVE subset alongside the full marker list so the clamp can tell a
      // bare imperative from a quoted/defensive occurrence.
      const preScan = preScanInjection(g.content);
      const markers = preScan.markers;

      if (circuitTripped) {
        verdicts[i] = failSafeVerdict(g.key, markers, opts.defaultVerdictOnError);
        groupsFailSafe++;
        done++;
        opts.onProgress?.(done, groups.length);
        return;
      }

      const outcome = await judgeOneGroup(
        g,
        preScan,
        opts,
        fetchImpl,
        apiUrl,
      );
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
  preScan: PreScanResult,
  opts: JudgeOptions,
  fetchImpl: FetchImpl,
  apiUrl: string,
): Promise<GroupVerdict> {
  const markers = preScan.markers;
  // Fresh nonce per group — an injected fake delimiter can never match it.
  const nonce = makeNonce();
  const systemPrompt = buildSystemPrompt({
    nonce,
    category: group.category,
    rubric: opts.rubrics[group.category],
    language: group.language,
    // The model sees ALL flagged markers as a hint (directive + quoted), so it
    // can reason about each one and explain benign provenance where applicable.
    injectionMarkers: markers,
  });
  const baseUserMsg = buildUserMessage(nonce, group.content);

  let attempts = 0;
  let totalCost = 0;
  let prevError: string | null = null;
  // A1/A7 model-health: emit each degradation kind AT MOST ONCE per group call
  // (across this group's retry attempts), mirroring the main-path 429-flood
  // collapse. Logging-only — never alters the retry loop / fail-safe.
  let emitted429 = false;
  let emittedNonRetryable = false;
  let emittedEmpty = false;

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
    // One judge HTTP attempt = one usage-history line. Time each attempt so a
    // retry produces its own line with its own ok/duration.
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
      // Do NOT clear the timeout here. The body read below (res.json /
      // res.text) is ALSO tied to controller.signal, so keeping the timer armed
      // bounds a slow/hung RESPONSE BODY too — a provider that returns headers
      // fast then stalls the body must not hang the call indefinitely (the
      // timeout used to be cleared right here, leaving res.json() unbounded).
      // The timer is cleared after each body read and on every exit path below.
    } catch (e) {
      clearTimeout(timeoutId);
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      const err = e as Error;
      prevError =
        err.name === "AbortError"
          ? `timeout after ${opts.perCallTimeoutMs}ms`
          : `network error: ${err.message}`;
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      clearTimeout(timeoutId);
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      // A1/A7 model-health (judge path knows opts.model): classify the HTTP
      // failure once per group call. 429 → rate_limit_429 (the security_scan
      // judge has its own fetch+retry, distinct from the main path). A 4xx
      // (non-429) → non_retryable_failure. Logging-only; control flow unchanged.
      if (res.status === 429) {
        if (!emitted429) {
          emitted429 = true;
          appendModelEvent(opts.model, "rate_limit_429", "429 during judge call");
        }
      } else if (res.status >= 400 && res.status < 500) {
        if (!emittedNonRetryable) {
          emittedNonRetryable = true;
          appendModelEvent(opts.model, "non_retryable_failure", `HTTP ${res.status} (judge)`);
        }
      }
      prevError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      continue;
    }

    let respJson: {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      respJson = (await res.json()) as typeof respJson;
      clearTimeout(timeoutId);
    } catch (e) {
      clearTimeout(timeoutId);
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      const err = e as Error;
      prevError =
        err.name === "AbortError"
          ? `timeout after ${opts.perCallTimeoutMs}ms (response body)`
          : `non-JSON HTTP body: ${err.message}`;
      continue;
    }

    const content = respJson.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      recordRequest({ ok: false, durationMs: Date.now() - attemptStart, costUsd: 0 });
      // A1/A7: the model returned a parseable reply with no message content —
      // an empty_response degradation signal. Once per group call. Logging-only.
      if (!emittedEmpty) {
        emittedEmpty = true;
        appendModelEvent(opts.model, "empty_response", "no message.content (judge)");
      }
      prevError = "response had no message.content string";
      continue;
    }

    const callCost = computeCallCost(
      respJson.usage,
      opts.pricing,
      Buffer.byteLength(group.content, "utf-8"),
      content.length,
    );
    totalCost += callCost;
    // The HTTP request itself succeeded (a parseable, billed response came
    // back) — record it with this call's own cost, regardless of whether the
    // verdict then fails validation below (that is a content issue, not a
    // failed web request).
    recordRequest({ ok: true, durationMs: Date.now() - attemptStart, costUsd: callCost });

    const validated = validateVerdictResponse(content, nonce);
    if (!validated.ok) {
      prevError = validated.reason;
      continue;
    }

    // Success — apply the injection clamp (§3.6) and return. Issue #9: pass the
    // DIRECTIVE subset so only bare-imperative markers feed the hard clamp;
    // quoted/definitional/defensive hits remain reported (in `markers`) but do
    // not force a not_threat→uncertain downgrade. SIGNAL B (reason backstop)
    // still protects Issue #7 regardless of this subset.
    const clamped = applyInjectionClamp(
      validated.payload,
      markers,
      preScan.directiveMarkers,
    );
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
 * F4 (aegis 2026-05-23) + Issue #7 (2026-05-24) — DETERMINISTIC injection
 * clamp. A `not_threat` verdict can no longer survive on model say-so when ANY
 * of three independent signals fires. None is gated on confidence.
 *
 * SIGNAL A — hard pre-scan markers (F4) + DIRECTIVE gate (Issue #9). The script
 *   flagged a HARD injection marker in the SNIPPET *and* that marker was
 *   classified DIRECTIVE (a bare imperative in prose — preScanInjection's
 *   directiveMarkers). A not_threat is then clamped whether the model
 *   acknowledged it (injection_observed=true, internally contradictory per
 *   §3.2) or not (returned benign without acknowledging the payload). Issue #9:
 *   a QUOTED / DEFINITIONAL / DEFENSIVE marker hit (a pattern definition, a
 *   detector's own source, a "do NOT comply" doc) is NO LONGER sufficient for
 *   SIGNAL A — it is still reported in injection_markers and still surfaces
 *   injection_observed=true, but the model's verdict is allowed to stand. When
 *   directiveMarkers is omitted, every marker counts as directive (legacy
 *   behavior preserved).
 *
 * SIGNAL B — reason backstop (Issue #7, the KEY invariant). Independent of the
 *   static marker list: if the model's OWN `reason` parrots the manipulation
 *   (cites the reviewer / "the AI" / its rubric / "approved by … team" / being
 *   instructed to classify benign), clamp to uncertain. This closes the
 *   "missed marker = silent fail-open" hole — a novel phrasing that dodges the
 *   pre-scan still gets caught when the not_threat justification echoes the
 *   injection. THIS is the fix for the T10 fail-open (not_threat @ conf 1.0
 *   with empty markers).
 *
 * SIGNAL C — self-reference (Issue #7). When a SELF_REFERENCE marker fired
 *   ("addresses-reviewer" / "directed-verdict"), the snippet is talking to the
 *   judge — which is, by construction, an injection attempt. We force
 *   injection_observed=true regardless of what the model said, even for a
 *   threat/uncertain verdict.
 *
 * threat / uncertain verdicts are never weakened; we only surface
 * injection_observed=true so the report records the attempt. Soft markers (e.g.
 * base64-blob, common in minified code) never clamp on their own — they are
 * filtered out before the hard-marker test. SIGNAL B runs on the model reason,
 * so it fires even when the marker list is empty.
 */
export function applyInjectionClamp(
  payload: VerdictPayload,
  markers: string[],
  directiveMarkers?: string[],
): VerdictPayload {
  // Issue #9 (2026-05-24): SIGNAL A now clamps ONLY on markers classified as
  // DIRECTIVE (a bare imperative in prose). Quoted / definitional / defensive
  // marker hits stay in `markers` (reported below via forceObserved) but no
  // longer force a not_threat→uncertain downgrade on their own — that is the
  // false-positive fix. When `directiveMarkers` is omitted (legacy callers that
  // pass only a flat marker list) we treat EVERY marker as directive, which
  // preserves the pre-#9 behavior exactly. The Issue #7 protection is NOT
  // weakened: it lives in SIGNAL B (the reason backstop), which is independent
  // of this classification and still clamps a not_threat whose justification
  // parrots the manipulation.
  const directiveSet = new Set(directiveMarkers ?? markers);
  const hardMarkers = markers.filter(
    (m) => !SOFT_MARKERS.has(m) && directiveSet.has(m),
  );
  // SIGNAL B is computed unconditionally — it must catch the empty-marker case.
  const reasonTells = scanReasonTells(payload.reason);
  // SIGNAL C — did the snippet address the reviewer/judge?
  const selfReference = markers.some((m) => SELF_REFERENCE_MARKERS.has(m));
  // injection_observed is forced true by any of: a fired marker (existing
  // behavior), a self-reference marker, or a reason that parrots the attack.
  const forceObserved =
    markers.length > 0 || selfReference || reasonTells.length > 0;

  if (payload.verdict === "not_threat") {
    // Clamp on EITHER a hard marker (A) or a reason tell (B). Either alone is
    // sufficient — B is what saves us when the pre-scan missed the phrasing.
    if (hardMarkers.length > 0 || reasonTells.length > 0) {
      const reasons: string[] = [];
      if (hardMarkers.length > 0) {
        const why = payload.injection_observed
          ? "the model acknowledged an injection attempt yet still returned not_threat (internally contradictory)"
          : "the model returned not_threat without acknowledging the flagged injection markers";
        reasons.push(
          `script pre-scan flagged injection markers (${hardMarkers.join(", ")}) and ${why}`,
        );
      }
      if (reasonTells.length > 0) {
        reasons.push(
          `the model's own justification parrots the manipulation (${reasonTells.join(", ")})`,
        );
      }
      return {
        verdict: "uncertain",
        // Cap confidence — we are overriding the model, so we are not certain.
        confidence: Math.min(payload.confidence, 0.5),
        reason: `Clamped to uncertain: ${reasons.join("; ")}. Original reason: ${payload.reason}`.slice(
          0,
          600,
        ),
        injection_observed: true,
      };
    }
    // A not_threat with no marker and no reason tell stands — but still surface
    // injection_observed if a self-reference marker somehow fired without being
    // hard (defensive; SELF_REFERENCE markers are hard, so this is belt-and-suspenders).
    if (forceObserved && !payload.injection_observed) {
      return { ...payload, injection_observed: true };
    }
    return payload;
  }

  // threat / uncertain pass through — only surface that an attempt was present.
  if (forceObserved && !payload.injection_observed) {
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
