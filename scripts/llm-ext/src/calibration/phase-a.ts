/**
 * calibration/phase-a.ts — Phase A, "works at all" (P6, spec section 4.2).
 *
 * The pure scorers come first (unit-tested with degenerate answerers in
 * phase-a.test.ts); the phase itself only sends requests to the cal server and
 * records each trial through the runner's progress, so a crash resumes here.
 *
 * Pass = the known answer is right and thinking can be turned off (2 trials).
 * Everything else (thinking on, json_schema, chars per token, speed) is
 * measured and reported, never a failure.
 */

import { localsOutgoingModel } from "../local-locals-server.js";
import type { Phase, PhaseContext } from "./runner.js";
import type { TrialRecord } from "./state.js";

// ── Replies and scorers (pure) ──────────────────────────────────────────

/** One chat reply, reduced to what the scorers read. */
export interface Reply {
  /** HTTP status; 0 when the request timed out or the connection failed. */
  status: number;
  content: string;
  /** llama-server `reasoning_content`, or a `reasoning` field (other engines). */
  reasoning: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  timedOut: boolean;
  /** The server's text for a non-200 reply (or the network error). */
  error?: string;
  /** llama-server `timings` (prompt_per_second, predicted_per_second), when present. */
  promptPerSecond?: number;
  predictedPerSecond?: number;
  wallMs: number;
}

export type Outcome = "pass" | "fail" | "inconclusive";

/** Parse an OpenAI-shaped chat completion body into a Reply. */
export function parseReply(status: number, body: string, wallMs: number): Reply {
  const base: Reply = { status, content: "", reasoning: "", finishReason: null, promptTokens: null, completionTokens: null, timedOut: false, wallMs };
  if (status !== 200) return { ...base, error: body.slice(0, 500) };
  let j: {
    choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    timings?: { prompt_per_second?: unknown; predicted_per_second?: unknown };
  };
  try {
    j = JSON.parse(body) as typeof j;
  } catch {
    return { ...base, status: 502, error: `not JSON: ${body.slice(0, 200)}` };
  }
  const c = j.choices?.[0];
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    ...base,
    content: str(c?.message?.content),
    reasoning: str(c?.message?.reasoning_content) || str(c?.message?.reasoning),
    finishReason: typeof c?.finish_reason === "string" ? c.finish_reason : null,
    promptTokens: num(j.usage?.prompt_tokens),
    completionTokens: num(j.usage?.completion_tokens),
    promptPerSecond: num(j.timings?.prompt_per_second) ?? undefined,
    predictedPerSecond: num(j.timings?.predicted_per_second) ?? undefined,
  };
}

/**
 * The answer without thinking (spec section 4): every `<think>…</think>`
 * block, an unclosed `<think>` up to the end, and anything before an orphan
 * `</think>` (a template that opens the block in the prompt).
 */
export function stripThinking(content: string): string {
  let s = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const close = s.lastIndexOf("</think>");
  if (close >= 0) s = s.slice(close + "</think>".length);
  const open = s.indexOf("<think>");
  if (open >= 0) s = s.slice(0, open);
  return s.trim();
}

/** Did the reply think: a reasoning field, or a think tag in the content. */
export const hasReasoning = (r: Reply): boolean => r.reasoning.trim() !== "" || /<\/?think>/.test(r.content);

/** Case, spaces and hyphens normalised (spec section 4). */
export const normalise = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[-‐-―]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** A reply cut at max_tokens or by the timeout proves nothing either way (spec 4: inconclusive, never a fail). */
const cut = (r: Reply): boolean => r.timedOut || r.finishReason === "length";

/**
 * The known answer (spec 4.2): the normalised answer holds the expected token
 * as a whole word, and no number other than the expected one and the ones the
 * question itself contains. Without that second rule, a reply listing every
 * number from 1 to 100 would pass.
 */
export function knownAnswerOutcome(r: Reply, expected: string, question: string): Outcome {
  if (cut(r)) return "inconclusive";
  if (r.status !== 200) return "fail";
  const words: string[] = normalise(stripThinking(r.content)).match(/[a-z0-9]+/g) ?? [];
  const allowed = new Set<string>([expected, ...(normalise(question).match(/\d+/g) ?? [])]);
  if (!words.includes(expected)) return "fail";
  return words.some((w) => /^\d+$/.test(w) && !allowed.has(w)) ? "fail" : "pass";
}

/** Thinking off (spec 4.2, N2): no reasoning field, no think block, and an answer is left. */
export function thinkingOffOutcome(r: Reply): Outcome {
  if (cut(r)) return "inconclusive";
  if (r.status !== 200 || hasReasoning(r)) return "fail";
  return stripThinking(r.content) === "" ? "fail" : "pass";
}

/** Thinking on (spec 4.2, F16): it must produce reasoning. */
export function thinkingOnOutcome(r: Reply): Outcome {
  if (cut(r)) return "inconclusive";
  return r.status === 200 && hasReasoning(r) ? "pass" : "fail";
}

/** The json_schema outcome: HTTP 400 = the engine refuses the schema (recorded as unsupported with its text). */
export function jsonOutcome(r: Reply, check: (v: unknown) => boolean): Outcome | "unsupported" {
  if (r.status === 400) return "unsupported";
  if (cut(r)) return "inconclusive";
  if (r.status !== 200) return "fail";
  try {
    return check(JSON.parse(stripThinking(r.content))) ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const exactKeys = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);

/** The small strict schema and its checker. */
export const SMALL_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, population: { type: "integer" } },
  required: ["city", "population"],
  additionalProperties: false,
} as const;
export const checkSmall = (v: unknown): boolean =>
  isObj(v) && exactKeys(v, ["city", "population"]) && typeof v.city === "string" && v.city.trim() !== "" && Number.isInteger(v.population);

/** The array schema scouting sends for its 40-record minimum (F7): exactly 40 items. */
export const ARRAY40_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 40,
      maxItems: 40,
      items: {
        type: "object",
        properties: { id: { type: "integer" }, label: { type: "string", enum: ["even", "odd"] } },
        required: ["id", "label"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;
export const checkArray40 = (v: unknown): boolean =>
  isObj(v) &&
  exactKeys(v, ["items"]) &&
  Array.isArray(v.items) &&
  v.items.length === 40 &&
  v.items.every((i) => isObj(i) && exactKeys(i, ["id", "label"]) && Number.isInteger(i.id) && (i.label === "even" || i.label === "odd"));

// ── Fixtures ────────────────────────────────────────────────────────────

export const KNOWN_QUESTION = "What is 6 times 7? Reply with the number only.";
export const KNOWN_ANSWER = "42";

/** A small deterministic PRNG (mulberry32): the same seed rebuilds the same text. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "river stone market window garden letter engine winter silver harbor quiet morning station paper copper meadow lantern cable forest signal ladder orchard pocket canvas thunder bridge marble candle feather valley".split(
    " ",
  );

/** Prose of about `chars` characters from `seed`. */
export function proseOf(seed: number, chars: number): string {
  const r = prng(seed);
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    const len = 6 + Math.floor(r() * 10);
    const words = Array.from({ length: len }, () => WORDS[Math.floor(r() * WORDS.length)]);
    const s = `${words[0][0].toUpperCase()}${words.join(" ").slice(1)}.`;
    out.push(s);
    n += s.length + 1;
  }
  return out.join(" ");
}

/** The three chars_per_token probe documents (prose, code, JSON lines), about 2,000 characters each. */
export function probeDocuments(): string[] {
  const code = Array.from({ length: 40 }, (_, i) => `function step${i}(x) {\n  return x * ${i + 3} + ${(i * 7) % 11};\n}`).join("\n");
  const json = Array.from({ length: 45 }, (_, i) => JSON.stringify({ id: i, name: WORDS[i % WORDS.length], ok: i % 2 === 0, score: (i * 13) % 97 })).join("\n");
  return [proseOf(101, 2000).slice(0, 2000), code.slice(0, 2000), json.slice(0, 2000)];
}

// ── The phase ───────────────────────────────────────────────────────────

/** Caps on completion tokens (spec section 4: 8192 with thinking on, 2048 with it off). */
export const CAP_ON = 8192;
export const CAP_OFF = 2048;
/** Before the speed is measured, a speed request may take this long. */
const MEASURE_TIMEOUT_MS = 600_000;
/** Attempts per required conclusive trial before the step is given up as inconclusive. */
const EXTRA_ATTEMPTS = 2;

export type Thinking = "on" | "off";

export interface Sender {
  chat: (messages: Array<{ role: string; content: string }>, o: { thinking: Thinking; maxTokens: number; timeoutMs: number; responseFormat?: unknown }) => Promise<Reply>;
}

/**
 * The calibration request sender. It reads `ctx.server` on every call, so a
 * restarted cal server (Phase B reloads it at W) is used at once.
 */
export function makeSender(ctx: PhaseContext, localsIds: string[]): Sender {
  return {
    chat: async (messages, o) => {
      // Spec section 2 (review m5): every calibration request first gives way to the broker's work for other models.
      await ctx.waitForTurn();
      const s = ctx.server;
      const body: Record<string, unknown> = {
        messages,
        max_tokens: o.maxTokens,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: o.thinking === "on" },
      };
      if (o.responseFormat !== undefined) body.response_format = o.responseFormat;
      // Spec 4.3: the fact questions reuse the cached document prefix (llama-server; Locals keeps its own prefix cache).
      if (s.engine === "llama") body.cache_prompt = true;
      // Locals selects the thinking variant by id (local-locals-server.ts); llama-server takes any model field.
      body.model = s.engine === "locals" ? (localsOutgoingModel(localsIds, body) ?? s.model) : s.model;
      const t0 = Date.now();
      try {
        const res = await fetch(`${s.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${s.apiKey}` },
          body: JSON.stringify(body),
          // The timeout aborts the request, so the single cal slot is freed (llama-server cancels a closed request).
          signal: AbortSignal.timeout(o.timeoutMs),
        });
        return parseReply(res.status, await res.text(), Date.now() - t0);
      } catch (e) {
        const timedOut = (e as Error).name === "TimeoutError";
        return { status: 0, content: "", reasoning: "", finishReason: null, promptTokens: null, completionTokens: null, timedOut, error: (e as Error).message, wallMs: Date.now() - t0 };
      }
    },
  };
}

const now = (): string => new Date().toISOString();
const trialsOf = (ctx: PhaseContext, step: string): TrialRecord[] => ctx.progress.trials.filter((t) => t.step === step);
const replyData = (r: Reply): Record<string, number | string | boolean | null> => ({
  status: r.status,
  finish: r.finishReason,
  completion_tokens: r.completionTokens,
  prompt_tokens: r.promptTokens,
  reasoning: hasReasoning(r),
  wall_ms: r.wallMs,
  ...(r.error !== undefined ? { error: r.error.slice(0, 300) } : {}),
});

/**
 * Run `step` until it has `needed` conclusive trials (reusing those already in
 * progress), at most needed + EXTRA_ATTEMPTS attempts. Returns the conclusive
 * outcomes, or null when it stayed inconclusive.
 */
async function conclusive(ctx: PhaseContext, step: string, needed: number, run: () => Promise<{ outcome: Outcome; data: TrialRecord["data"] }>): Promise<Outcome[] | null> {
  const done = (): Outcome[] => trialsOf(ctx, step).map((t) => t.outcome).filter((o) => o !== "inconclusive");
  while (done().length < needed) {
    if (trialsOf(ctx, step).length >= needed + EXTRA_ATTEMPTS) return null;
    const { outcome, data } = await run();
    ctx.record({ step, seed: trialsOf(ctx, step).length, outcome, data, at: now() });
  }
  return done().slice(0, needed);
}

/** A measurement step done once (resumed from progress): its data. */
async function measured(ctx: PhaseContext, step: string, run: () => Promise<TrialRecord["data"]>): Promise<NonNullable<TrialRecord["data"]>> {
  const old = trialsOf(ctx, step).find((t) => t.outcome === "pass");
  if (old?.data) return old.data;
  const data = (await run()) ?? {};
  ctx.record({ step, seed: 0, outcome: "pass", data, at: now() });
  return data;
}

/** Per-trial timeout (spec section 4): 3 × (prefill + cap / decode), at least 120 s. */
export function trialTimeoutMs(promptTokens: number, cap: number, prefillTps: number, decodeTps: number): number {
  const s = 3 * (promptTokens / Math.max(prefillTps, 1) + cap / Math.max(decodeTps, 0.1));
  return Math.max(120_000, Math.ceil(s * 1000));
}

export const phaseA: Phase = {
  name: "A",
  run: async (ctx) => {
    const s = ctx.server;
    const auth = { authorization: `Bearer ${s.apiKey}` };
    const getJson = async (path: string): Promise<Record<string, unknown>> => {
      const res = await fetch(`${s.baseUrl}${path}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      return (await res.json()) as Record<string, unknown>;
    };
    const localsIds: string[] = [];
    if (s.engine === "locals") {
      const m = (await getJson("/v1/models")) as { data?: Array<{ id?: unknown }> };
      for (const d of m.data ?? []) if (typeof d.id === "string") localsIds.push(d.id);
    }
    const send = makeSender(ctx, localsIds);

    // Capabilities: llama /props (template caps, template text) and /v1/models meta; Locals /v1/models.
    const caps = await measured(ctx, "A/capabilities", async () => {
      if (s.engine === "llama") {
        const props = (await getJson("/props")) as { chat_template?: unknown; chat_template_caps?: Record<string, unknown>; default_generation_settings?: { n_ctx?: unknown } };
        const models = (await getJson("/v1/models")) as { data?: Array<{ meta?: { n_ctx_train?: unknown } }> };
        const tpl = typeof props.chat_template === "string" ? props.chat_template : "";
        return {
          template_thinking: /enable_thinking|<think>|reasoning_content/.test(tpl) || props.chat_template_caps?.supports_reasoning_effort === true,
          n_ctx_train: Number(models.data?.[0]?.meta?.n_ctx_train ?? 0),
          // The context each slot really got: llama-server caps -c at the model's trained context.
          n_ctx: Number(props.default_generation_settings?.n_ctx ?? 0),
          load_ms: ctx.loadMs,
        };
      }
      const m = (await getJson("/v1/models")) as { data?: Array<{ id?: unknown; context_length?: unknown }> };
      return {
        template_thinking: localsIds.some((id) => id.endsWith("-thinking")),
        n_ctx_train: Number(m.data?.find((d) => typeof d.context_length === "number")?.context_length ?? 0),
        // Locals reports no slot context; its window is the model's (Locals does not cap it below that).
        n_ctx: Number(m.data?.find((d) => typeof d.context_length === "number")?.context_length ?? 0),
        load_ms: ctx.loadMs,
      };
    });

    // Phase A runs at the harness context (spec 4.2, N8: 16384, so an 8k speed prompt plus its output fits). A server
    // that got less (llama-server caps -c at the trained context) fails here with the reason, not later in an HTTP 400.
    const nCtx = Number(caps.n_ctx);
    const needCtx = ctx.harness.phaseACtx;
    if (nCtx > 0 && nCtx < needCtx) {
      ctx.log(`Phase A FAIL: the server's context is ${nCtx} tokens; Phase A needs ${needCtx}`);
      return { passed: false, step: "phase-a/context", message: `the model's context is ${nCtx} tokens (trained ${String(caps.n_ctx_train)}); calibration needs at least ${needCtx}` };
    }

    // chars_per_token from the three probe documents.
    const cptData = await measured(ctx, "A/chars-per-token", async () => {
      let chars = 0;
      let tokens = 0;
      if (s.engine === "llama") {
        for (const doc of probeDocuments()) {
          const res = await fetch(`${s.baseUrl}/tokenize`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ content: doc }), signal: AbortSignal.timeout(60_000) });
          const n = ((await res.json()) as { tokens?: unknown[] }).tokens?.length ?? 0;
          chars += doc.length;
          tokens += n;
        }
      } else {
        // Locals has no /tokenize: the prompt tokens of a 1-token completion, minus those of a near-empty message.
        const base = await send.chat([{ role: "user", content: "x" }], { thinking: "off", maxTokens: 1, timeoutMs: MEASURE_TIMEOUT_MS });
        for (const doc of probeDocuments()) {
          const r = await send.chat([{ role: "user", content: `x${doc}` }], { thinking: "off", maxTokens: 1, timeoutMs: MEASURE_TIMEOUT_MS });
          chars += doc.length;
          tokens += (r.promptTokens ?? 0) - (base.promptTokens ?? 0);
        }
      }
      if (tokens <= 0) throw new Error("chars_per_token: the server reported no tokens for the probe documents");
      return { chars, tokens, chars_per_token: chars / tokens };
    });
    const cpt = Number(cptData.chars_per_token);

    // Speed: decode on a short prompt that runs to its cap; prefill at 2k and 8k (distinct texts, so a prompt cache cannot shortcut).
    const speed = await measured(ctx, "A/speed", async () => {
      const dec = await send.chat([{ role: "user", content: "Count from 1 to 500, separated by spaces." }], { thinking: "off", maxTokens: 256, timeoutMs: MEASURE_TIMEOUT_MS });
      if (dec.status !== 200) throw new Error(`speed: decode request failed: HTTP ${dec.status} ${dec.error ?? ""}`);
      const decodeTps = dec.predictedPerSecond ?? (dec.completionTokens ?? 0) / Math.max(dec.wallMs / 1000, 0.001);
      const prefill = async (tokens: number, seed: number): Promise<{ tps: number; tokens: number }> => {
        const text = proseOf(seed, Math.floor(tokens * cpt));
        const r = await send.chat([{ role: "user", content: `${text}\n\nReply with OK.` }], { thinking: "off", maxTokens: 1, timeoutMs: MEASURE_TIMEOUT_MS });
        if (r.status !== 200) throw new Error(`speed: ${tokens}-token prefill failed: HTTP ${r.status} ${r.error ?? ""}`);
        const n = r.promptTokens ?? tokens;
        return { tps: r.promptPerSecond ?? n / Math.max(r.wallMs / 1000, 0.001), tokens: n };
      };
      const p2 = await prefill(2048, 202);
// A reduced harness (spec 9) runs Phase A below 16384: the second prefill then fits its context.
      const p8 = await prefill(Math.min(8192, ctx.harness.phaseACtx - 1024), 808);
      return { decode_tps: decodeTps, decode_tokens: dec.completionTokens, prefill_tps_2k: p2.tps, prompt_tokens_2k: p2.tokens, prefill_tps_8k: p8.tps, prompt_tokens_8k: p8.tokens };
    });
    const prefillTps = Math.min(Number(speed.prefill_tps_2k), Number(speed.prefill_tps_8k));
    const decodeTps = Number(speed.decode_tps);
    const timeout = (cap: number, promptTokens = 512): number => trialTimeoutMs(promptTokens, cap, prefillTps, decodeTps);
    const ask = (thinking: Thinking, extra: { responseFormat?: unknown; question?: string } = {}): Promise<Reply> => {
      const cap = thinking === "on" ? CAP_ON : CAP_OFF;
      return send.chat([{ role: "user", content: extra.question ?? KNOWN_QUESTION }], { thinking, maxTokens: cap, timeoutMs: timeout(cap), responseFormat: extra.responseFormat });
    };

    // Known answer, with thinking off (the mode every fact task runs in).
    const known = await conclusive(ctx, "A/known-answer", 1, async () => {
      const r = await ask("off");
      return { outcome: knownAnswerOutcome(r, KNOWN_ANSWER, KNOWN_QUESTION), data: { ...replyData(r), answer: stripThinking(r.content).slice(0, 80) } };
    });
    const off = await conclusive(ctx, "A/thinking-off", 2, async () => {
      const r = await ask("off");
      return { outcome: thinkingOffOutcome(r), data: replyData(r) };
    });
    const on = await conclusive(ctx, "A/thinking-on", 2, async () => {
      const r = await ask("on");
      return { outcome: thinkingOnOutcome(r), data: replyData(r) };
    });

    // json_schema: the small schema twice per thinking mode, then the 40-item array.
    let jsonError: string | undefined;
    const json = async (step: string, thinking: Thinking, schema: unknown, check: (v: unknown) => boolean, question: string, n: number): Promise<boolean> => {
      const outs = await conclusive(ctx, step, n, async () => {
        const r = await ask(thinking, { question, responseFormat: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } } });
        const o = jsonOutcome(r, check);
        if (o === "unsupported") jsonError ??= r.error;
        // An unsupported schema is a conclusive "no" (recorded as fail with the server's text).
        return { outcome: o === "unsupported" ? "fail" : o, data: { ...replyData(r), unsupported: o === "unsupported" } };
      });
      for (const t of trialsOf(ctx, step)) if (t.data?.unsupported === true && typeof t.data.error === "string") jsonError ??= t.data.error;
      return outs !== null && outs.every((o) => o === "pass");
    };
    const smallQ = "Give the name and the population of the largest city in France.";
    const jsonOff = await json("A/json-off", "off", SMALL_SCHEMA, checkSmall, smallQ, 2);
    const jsonOn = await json("A/json-on", "on", SMALL_SCHEMA, checkSmall, smallQ, 2);
    const array40 = await json("A/json-array40", "off", ARRAY40_SCHEMA, checkArray40, "Label each whole number from 1 to 40 as even or odd: one item per number, with its id and label.", 1);

    const knownOk = known !== null && known[0] === "pass";
    const offOk = off !== null && off.every((o) => o === "pass");
    const onOk = on !== null && on.every((o) => o === "pass");
    const summary = {
      passed: knownOk && offOk,
      load_s: Math.round(Number(caps.load_ms) / 100) / 10,
      n_ctx_train: Number(caps.n_ctx_train),
      template_thinking: caps.template_thinking === true,
      chars_per_token: Math.round(cpt * 100) / 100,
      decode_tps: Math.round(decodeTps * 10) / 10,
      prefill_tps_2k: Math.round(Number(speed.prefill_tps_2k)),
      prefill_tps_8k: Math.round(Number(speed.prefill_tps_8k)),
      thinking_off: offOk,
      thinking_on: onOk,
      json_off: jsonOff,
      json_on: jsonOn,
      array40,
      ...(jsonError !== undefined ? { json_error: jsonError.slice(0, 200) } : {}),
    };
    ctx.record({ step: "A/summary", seed: 0, outcome: summary.passed ? "pass" : "fail", data: summary, at: now() });
    ctx.log(
      `Phase A ${summary.passed ? "PASS" : "FAIL"}: load ${summary.load_s} s; decode ${summary.decode_tps} tok/s, prefill ${summary.prefill_tps_2k} tok/s (2k) ${summary.prefill_tps_8k} tok/s (8k); ` +
        `json_schema off ${jsonOff} on ${jsonOn} array40 ${array40}${jsonError ? ` (${jsonError.slice(0, 120)})` : ""}; thinking off ${offOk} on ${onOk}; known answer ${knownOk}; chars/token ${summary.chars_per_token}; n_ctx_train ${summary.n_ctx_train}`,
    );
    if (!onOk) ctx.log("thinking cannot be turned on: the bug kind will run with thinking off (thinking_works.on: false)");
    if (known === null) return { passed: false, step: "phase-a/known-answer", message: "the known-answer trial stayed inconclusive (cut at max_tokens or timed out) on every attempt" };
    if (!knownOk) return { passed: false, step: "phase-a/known-answer", message: `the known answer (${KNOWN_ANSWER} to "${KNOWN_QUESTION}") was not given` };
    if (off === null) return { passed: false, step: "phase-a/thinking-off", message: "the thinking-off trials stayed inconclusive on every attempt" };
    if (!offOk) return { passed: false, step: "phase-a/thinking-off", message: "thinking cannot be turned off (the reply carried reasoning or only a think block)" };
    return { passed: true };
  },
};
