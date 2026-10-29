/**
 * calibration/phase-b.ts — Phase B, "safe input size" (P6; spec section 4.3,
 * with the window W of section 4.1).
 *
 * W: the cal server is stopped, free memory is read, and W is the largest
 * context that fits beside the weights (memory.ts); the server is reloaded
 * with one slot at W. Then each task kind (fact, aggregate, bug) walks the
 * grid from its top step down until a step passes the sequential rule; that
 * step is the kind's `fill_tokens` (0 = unfit at the floor). Every trial is
 * recorded through the runner's progress, so a crash or a SIGKILL resumes at
 * the next trial. No record is written here: the runner writes one only when
 * every phase passed (round-2 review F13).
 */

import { timingsFromEnv } from "../broker/scheduler.js";
import { memoryFreePercent } from "../local-locals-server.js";
import { pidState } from "../local-llama-server.js";
import { chooseWindow, freeMemory, kvBytes, modelKvLayers, weightBytes } from "./memory.js";
import { CAP_OFF, CAP_ON, LEAKY_LIMIT, makeSender, shortOffCompletions, thinkingOffMode, trialTimeoutMs, type Outcome, type Reply, type Sender, type Thinking } from "./phase-a.js";
import {
  AGGREGATE_COUNT_QUESTION,
  AGGREGATE_LIST_QUESTION,
  aggregateCountOutcome,
  aggregateDocument,
  aggregateIsCount,
  aggregateListOutcome,
  BUG_SCHEMA,
  bugDocument,
  bugOutcome,
  bugQuestion,
  factDocument,
  factOutcome,
  factQuestion,
  gridSteps,
  outputFloor,
  seedOf,
  sequentialVerdict,
  variantSeed,
  walkGrid,
  cutOutcome,
  transportVerdict,
  type FactDoc,
} from "./phase-b-fixtures.js";
import type { GridEntry, TaskKind } from "./record.js";
import type { Phase, PhaseContext } from "./runner.js";
import type { TrialRecord } from "./state.js";

/** A trial whose prompt is further than this from its step is rebuilt, never scored (spec 4.3). */
const SIZE_TOLERANCE = 0.03;
/** Rebuilds of one trial's input before the step is given up as an error. */
const MAX_REBUILDS = 4;
/** Spec section 2: the third cal server crash in one step fails the model. */
const MAX_STEP_CRASHES = 3;
/** Spec 4.1: the post-load check halves W, never below this (a reduced harness keeps its own cap). */
const MIN_HALVED_WINDOW = 8192;

class StepPaused extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}
class StepFailed extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

const now = (): string => new Date().toISOString();
const stepKey = (kind: TaskKind, tokens: number): string => `B/${kind}/${tokens}`;
type Counter = GridEntry["counter"];

/** The data of the last passing trial of `step` (Phase A's measurements), or null. */
function dataOf(ctx: PhaseContext, step: string): NonNullable<TrialRecord["data"]> | null {
  const t = [...ctx.progress.trials].reverse().find((x) => x.step === step && x.data);
  return t?.data ?? null;
}

interface Built {
  /** The user message: the document, then the question. */
  content: string;
  /** Characters of the document part (what the size is tuned on). */
  docChars: number;
  score: (r: Reply) => Outcome;
  /** The expected answer is under 20 tokens (a fact code, an aggregate count): its length shows a leaky thinking off (D5). */
  short?: boolean;
}

/**
 * Phase B's run state: the window, the sender, and the per-kind sizing
 * (characters per token learned from the replies; llama's tokenizer count
 * plus the chat template's overhead).
 */
interface Run {
  ctx: PhaseContext;
  send: Sender;
  window: number;
  prefillTps: number;
  decodeTps: number;
  cpt: Record<TaskKind, number>;
  overhead: Record<TaskKind, number>;
}

/** llama-server /tokenize: the token count of `text` (no chat template). */
async function tokenize(ctx: PhaseContext, text: string): Promise<number> {
  const s = ctx.server;
  const res = await fetch(`${s.baseUrl}/tokenize`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`/tokenize answered HTTP ${res.status}`);
  return ((await res.json()) as { tokens?: unknown[] }).tokens?.length ?? 0;
}

/**
 * Build a trial's input at `tokens` prompt tokens (spec 4.3 "Sizing"): the
 * characters come from the learned characters per token; on llama the count
 * is checked with /tokenize before anything is sent, so a real request is
 * rarely rebuilt. Returns the input and the characters used.
 */
async function sized(run: Run, kind: TaskKind, tokens: number, build: (chars: number) => Built): Promise<Built> {
  let chars = Math.max(200, Math.round((tokens - run.overhead[kind]) * run.cpt[kind]));
  let b = build(chars);
  if (run.ctx.server.engine !== "llama") return b;
  for (let i = 0; i < 6; i++) {
    const n = (await tokenize(run.ctx, b.content)) + run.overhead[kind];
    if (Math.abs(n - tokens) / tokens <= SIZE_TOLERANCE / 2) return b;
    chars = Math.max(200, Math.round(chars * (tokens / n)));
    b = build(chars);
  }
  return b;
}

/**
 * One scored trial: built to size, sent, size-checked against the reply's
 * real prompt tokens (more than 3 % off: rebuilt, never scored), with cal
 * server crashes counted per step (the third fails the model; spec 2).
 */
async function oneTrial(run: Run, kind: TaskKind, tokens: number, thinking: Thinking, json: boolean, build: (chars: number) => Built): Promise<{ outcome: Outcome; reply: Reply; promptTokens: number; cap: number; short: boolean }> {
  const { ctx } = run;
  const key = stepKey(kind, tokens);
  for (let rebuild = 0; ; rebuild++) {
    const b = await sized(run, kind, tokens, build);
    const cap = Math.max(64, Math.min(thinking === "on" ? CAP_ON : CAP_OFF, run.window - tokens - 64));
    const before = ctx.server;
    const r = await run.send.chat([{ role: "user", content: b.content }], {
      thinking,
      maxTokens: cap,
      timeoutMs: trialTimeoutMs(tokens, cap, run.prefillTps, run.decodeTps),
      responseFormat: json ? { type: "json_schema", json_schema: { name: "bug", strict: true, schema: BUG_SCHEMA } } : undefined,
    });
    // D3 (main-agent decision 2026-10-29): only the same server process, still alive after the request, makes a
    // failed request a network error (inconclusive, rerun); a dead or replaced server is a crash, counted per step.
    const verdict = transportVerdict(r, ctx.server === before && before.alive() && pidState(before.entry.pid) === "alive");
    if (verdict === "crash") {
      const crashes = (ctx.progress.stepCrashes ??= {});
      crashes[key] = (crashes[key] ?? 0) + 1;
      ctx.save();
      ctx.log(`the cal server crashed during ${key} (${crashes[key]} of ${MAX_STEP_CRASHES})`);
      if (crashes[key] >= MAX_STEP_CRASHES) throw new StepFailed(key, `the cal server crashed ${crashes[key]} times in step ${key}; its last log lines:\n${ctx.logTail()}`);
      await ctx.restart(run.window, 1);
      rebuild--;
      continue;
    }
    if (verdict === "inconclusive") return { outcome: "inconclusive", reply: r, promptTokens: r.promptTokens ?? 0, cap, short: b.short === true };
    const p = r.promptTokens;
    if (r.status === 200 && p !== null && p > 0) {
      // Learn the size of this kind's text from the real count (spec 4.3), whatever the verdict.
      if (ctx.server.engine === "llama") run.overhead[kind] = Math.max(0, p - (await tokenize(ctx, b.content)));
      else run.cpt[kind] = b.docChars / Math.max(1, p - run.overhead[kind]);
      if (Math.abs(p - tokens) / tokens > SIZE_TOLERANCE) {
        if (rebuild >= MAX_REBUILDS) throw new Error(`${key}: the prompt stayed more than 3 % off its step after ${MAX_REBUILDS} rebuilds (last ${p} tokens)`);
        ctx.log(`${key}: the prompt had ${p} tokens, more than 3 % off; rebuilt, not scored`);
        continue;
      }
    }
    return { outcome: b.score(r), reply: r, promptTokens: p ?? 0, cap, short: b.short === true };
  }
}

/**
 * The outcome of trial `index` of a counter, run (and rerun when
 * inconclusive) unless progress already has it. Spec section 2: an
 * inconclusive trial is rerun once; two in a row pause the step (the model
 * stays queued); after one pause, two more in a row fail the model.
 */
async function trialOutcome(run: Run, kind: TaskKind, tokens: number, counter: Counter, index: number, thinking: Thinking, json: boolean, build: (chars: number, attempt: number) => Built): Promise<Outcome> {
  const { ctx } = run;
  const key = stepKey(kind, tokens);
  const mine = (): TrialRecord[] => ctx.progress.trials.filter((t) => t.step === key && t.data?.counter === counter && t.data?.index === index);
  const done = mine().find((t) => t.outcome !== "inconclusive");
  if (done) return done.outcome;
  const pauses = ctx.progress.paused?.[key] ?? 0;
  const allowed = 2 * (pauses + 1);
  // Timeouts, network errors and cuts at a squeezed cap count towards the pause (D2, D3); a cut at the nominal cap
  // is settled by cutOutcome (D1).
  const nominal = thinking === "on" ? CAP_ON : CAP_OFF;
  const fullCut = (t: TrialRecord): boolean => t.data?.cut === true && Number(t.data.cap) >= nominal;
  const waits = (): number => mine().filter((t) => t.outcome === "inconclusive" && !fullCut(t)).length;
  while (waits() < allowed) {
    // A rerun gets a new document variant (variantSeed): at temperature 0 the same input repeats the same cut reply.
    const attempt = mine().filter((x) => x.outcome === "inconclusive").length;
    const t = await oneTrial(run, kind, tokens, thinking, json, (chars) => build(chars, attempt));
    const r = t.reply;
    // D1 (main-agent decision 2026-10-29): a reply cut at the nominal cap is rerun once on a new document; cut again,
    // it is a FAIL, so a kind whose answers do not fit the cap ends unfit instead of failing the whole model. The cap
    // is stored with the cut: a cut at a cap squeezed by the window is not the model's fault (review of a72827f9).
    const cut = r.finishReason === "length";
    const outcome = cut ? cutOutcome(mine().filter(fullCut).length, t.cap, nominal) : t.outcome;
    ctx.record({
      step: key,
      seed: index,
      outcome,
      data: {
        counter,
        index,
        status: r.status,
        finish: r.finishReason,
        cut,
        cap: t.cap,
        thinking,
        short: t.short,
        prompt_tokens: t.promptTokens,
        completion_tokens: r.completionTokens,
        reasoning: r.reasoning.trim() !== "",
        wall_ms: r.wallMs,
        ...(r.error !== undefined ? { error: r.error.slice(0, 200) } : {}),
      },
      at: now(),
    });
    if (outcome !== "inconclusive") return outcome;
  }
  const paused = (ctx.progress.paused ??= {});
  paused[key] = pauses + 1;
  ctx.save();
  if (paused[key] >= 2) throw new StepFailed(key, `trial ${index} of ${key} (${counter}) stayed inconclusive (timed out or a network error) after the step was paused once`);
  throw new StepPaused(key, `trial ${index} of ${key} (${counter}) was inconclusive (timed out or a network error) twice in a row`);
}

/** The conclusive outcomes of a counter in index order (what the sequential rule reads). */
function conclusiveOf(ctx: PhaseContext, key: string, counter: Counter): Outcome[] {
  return ctx.progress.trials
    .filter((t) => t.step === key && t.data?.counter === counter && t.outcome !== "inconclusive")
    .sort((a, b) => Number(a.data?.index) - Number(b.data?.index))
    .map((t) => t.outcome);
}

/** One counter run to its sequential verdict (spec 4.3). */
async function counterVerdict(run: Run, kind: TaskKind, tokens: number, counter: Counter, trial: (index: number) => Promise<Outcome>): Promise<"pass" | "fail"> {
  const key = stepKey(kind, tokens);
  for (;;) {
    const outs = conclusiveOf(run.ctx, key, counter);
    const v = sequentialVerdict(outs, run.ctx.harness.trials);
    if (v !== "more") return v;
    await trial(outs.length);
  }
}

/** Does `kind` pass at `tokens`? (Bug: both its counters, interleaved, must pass.) */
async function stepPasses(run: Run, kind: TaskKind, tokens: number, bugThinking: Thinking, bugJson: boolean): Promise<boolean> {
  const seed = seedOf(kind, tokens);
  if (kind === "fact") {
    // One document per 5 questions (spec 4.3): trial i asks needle i % 5 of document floor(i / 5).
    const docs = new Map<string, { doc: FactDoc; chars: number }>();
    const v = await counterVerdict(run, kind, tokens, "main", (i) =>
      trialOutcome(run, kind, tokens, "main", i, "off", false, (chars, attempt) => {
        const d = Math.floor(i / 5);
        // A rerun asks the same needle position of a new document (variantSeed).
        const docKey = `${d}/${attempt === 0 ? "" : i}/${attempt}`;
        let cached = docs.get(docKey);
        if (!cached || cached.chars !== chars) {
          cached = { doc: factDocument(attempt === 0 ? seedOf(seed, d) : variantSeed(seedOf(seed, d), i % 5, attempt), chars), chars };
          docs.set(docKey, cached);
        }
        const { doc } = cached;
        const needle = doc.needles[i % 5];
        const all = [...doc.needles, ...doc.decoys].map((x) => x.code);
        return { content: `${doc.text}\n\n${factQuestion(needle.vault)}`, docChars: doc.text.length, score: (r) => factOutcome(r, needle.code, all), short: true };
      }),
    );
    return v === "pass";
  }
  if (kind === "aggregate") {
    const v = await counterVerdict(run, kind, tokens, "main", (i) =>
      trialOutcome(run, kind, tokens, "main", i, "off", false, (chars, attempt) => {
        const doc = aggregateDocument(seed, i, chars, attempt);
        const count = aggregateIsCount(i);
        return {
          content: `${doc.text}\n\n${count ? AGGREGATE_COUNT_QUESTION : AGGREGATE_LIST_QUESTION}`,
          docChars: doc.text.length,
          score: (r) => (count ? aggregateCountOutcome(r, doc.vaults.length) : aggregateListOutcome(r, doc.vaults)),
          short: count,
        };
      }),
    );
    return v === "pass";
  }
  // Bug: the bug trial and its control twin share a seed (spec 4.3); the two counters run interleaved.
  const bugTrial = (counter: Counter) => (i: number) =>
    trialOutcome(run, kind, tokens, counter, i, bugThinking, bugJson, (chars, attempt) => {
      const doc = bugDocument(seed, i, chars, counter === "bug", attempt);
      return { content: `${doc.text}\n\n${bugQuestion(!bugJson)}`, docChars: doc.text.length, score: (r) => bugOutcome(r, doc) };
    });
  const key = stepKey(kind, tokens);
  for (;;) {
    const vb = sequentialVerdict(conclusiveOf(run.ctx, key, "bug"), run.ctx.harness.trials);
    const vc = sequentialVerdict(conclusiveOf(run.ctx, key, "control"), run.ctx.harness.trials);
    if (vb === "fail" || vc === "fail") return false;
    if (vb === "pass" && vc === "pass") return true;
    if (vb === "more") await bugTrial("bug")(conclusiveOf(run.ctx, key, "bug").length);
    if (vc === "more" && sequentialVerdict(conclusiveOf(run.ctx, key, "bug"), run.ctx.harness.trials) !== "fail") await bugTrial("control")(conclusiveOf(run.ctx, key, "control").length);
  }
}

/** The grid entries of one step, every count kept (spec 4.3). */
function gridOf(ctx: PhaseContext, kind: TaskKind, tokens: number): GridEntry[] {
  const key = stepKey(kind, tokens);
  const counters: Counter[] = kind === "bug" ? ["bug", "control"] : ["main"];
  return counters
    .map((counter) => {
      const ts = ctx.progress.trials.filter((t) => t.step === key && t.data?.counter === counter);
      return {
        kind,
        counter,
        tokens,
        trials: ts.filter((t) => t.outcome !== "inconclusive").length,
        passed: ts.filter((t) => t.outcome === "pass").length,
        inconclusive: ts.filter((t) => t.outcome === "inconclusive").length,
        cuts: ts.filter((t) => t.data?.cut === true).length,
        cut_fails: ts.filter((t) => t.data?.cut === true && t.outcome === "fail").length,
        cut_cap: ts.some((t) => t.data?.cut === true) ? Math.max(...ts.filter((t) => t.data?.cut === true).map((t) => Number(t.data?.cap ?? 0))) : null,
      };
    })
    .filter((g) => g.trials + g.inconclusive > 0);
}

/**
 * W (spec 4.1, coordinator decision 11): measured with the model unloaded. A
 * resume keeps the recorded W while free memory is within 25 % of what it was;
 * otherwise W is measured again, and a different W drops every Phase B trial.
 * Returns null when not even the smallest step fits: not a failure (ruling
 * L86-87), the model waits.
 */
async function measureWindow(ctx: PhaseContext, nCtxTrain: number, minWindow: number): Promise<{ window: number; free: number } | null> {
  const floorPct = timingsFromEnv(process.env).memoryFloorPct;
  const layers = modelKvLayers(ctx.item.engine, ctx.identity.files);
  const weights = weightBytes(ctx.identity.files);
  const cap = Math.min(ctx.harness.windowCap, nCtxTrain > 0 ? nCtxTrain : ctx.harness.windowCap);
  await ctx.stopServer("measuring free memory for the calibration window");
  const { free, floor } = await freeMemory(floorPct);
  const window = chooseWindow(layers, weights, free - floor, cap);
  const old = dataOf(ctx, "B/window");
  if (old !== null) {
    const oldFree = Number(old.free_ram_bytes);
    const oldWindow = Number(old.window_tokens);
    if (Math.abs(free - oldFree) <= 0.25 * oldFree || window === oldWindow) {
      ctx.log(`calibration window W = ${oldWindow} tokens (kept; free memory ${Math.round(free / 2 ** 20)} MiB)`);
      return { window: oldWindow, free: oldFree };
    }
    // Free memory moved by more than 25 % and W with it: every Phase B result was measured at the old W.
    ctx.log(`free memory changed from ${Math.round(oldFree / 2 ** 20)} to ${Math.round(free / 2 ** 20)} MiB and W from ${oldWindow} to ${window}: Phase B starts again`);
    ctx.progress.trials = ctx.progress.trials.filter((t) => !t.step.startsWith("B/") && !t.step.startsWith("C/"));
    for (const m of [ctx.progress.paused, ctx.progress.stepCrashes]) for (const k of Object.keys(m ?? {})) if (k.startsWith("B/") || k.startsWith("C/")) delete m?.[k];
    delete ctx.progress.phases.C;
    ctx.save();
  }
  if (window < minWindow) {
    ctx.log(`not enough free memory for calibration: W would be ${window} tokens (free ${Math.round(free / 2 ** 20)} MiB, floor ${Math.round(floor / 2 ** 20)} MiB, weights ${Math.round(weights / 2 ** 20)} MiB); the model waits`);
    return null;
  }
  ctx.record({
    step: "B/window",
    seed: 0,
    outcome: "pass",
    data: { window_tokens: window, free_ram_bytes: free, floor_bytes: floor, weight_bytes: weights, kv_bytes: kvBytes(layers, window), cap },
    at: now(),
  });
  ctx.log(`calibration window W = ${window} tokens (free ${Math.round(free / 2 ** 20)} MiB, floor ${Math.round(floor / 2 ** 20)} MiB, weights ${Math.round(weights / 2 ** 20)} MiB, KV ${Math.round(kvBytes(layers, window) / 2 ** 20)} MiB)`);
  return { window, free };
}

export const phaseB: Phase = {
  name: "B",
  run: async (ctx) => {
    const a = dataOf(ctx, "A/summary");
    const speed = dataOf(ctx, "A/speed");
    const caps = dataOf(ctx, "A/capabilities");
    if (!a || !speed || !caps || a.passed !== true) return { passed: false, step: "phase-b/needs-a", message: "Phase B needs the results of a passed Phase A (chars per token, speed, thinking, json_schema)" };
    const steps0 = gridSteps(ctx.harness.windowCap, ctx.harness.steps);
    const minWindow = ctx.harness.steps !== null ? Math.min(...ctx.harness.steps) + 256 : Math.ceil(2048 / 0.4);
    const kinds: TaskKind[] = ["fact", "aggregate", "bug"];
    // Spec 4.4: thinking off for fact and aggregate, on for bug; bug runs with it off when Phase A found it cannot be turned on.
    const bugThinking: Thinking = a.thinking_on === true ? "on" : "off";
    // json_schema for the bug answer only where Phase A proved it in that thinking mode; else the schema goes in the prompt.
    const bugJson = bugThinking === "on" ? a.json_on === true : a.json_off === true;
    try {
      const w = await measureWindow(ctx, Number(caps.n_ctx_train), minWindow);
      if (w === null) return { passed: false, paused: true, step: "B/window", message: "not enough free memory for the calibration window; the model waits" };
      let window = w.window;
      await ctx.restart(window, 1);
      // Spec 4.1: the post-load check can still lower W (halving, at least 8192).
      const floorPct = timingsFromEnv(process.env).memoryFloorPct;
      for (;;) {
        const pct = process.platform === "darwin" ? await memoryFreePercent() : null;
        const lower = Math.max(Math.min(MIN_HALVED_WINDOW, ctx.harness.windowCap), Math.floor(window / 2 / 256) * 256);
        if (pct === null || pct >= floorPct || lower >= window) break;
        ctx.log(`after loading at W = ${window}, free memory is ${pct} % (floor ${floorPct} %): W halved to ${lower}`);
        window = lower;
        ctx.record({ step: "B/window", seed: 1, outcome: "pass", data: { window_tokens: window, free_ram_bytes: w.free, halved: true }, at: now() });
        await ctx.restart(window, 1);
      }
      if (ctx.server.engine === "llama") {
        // llama-server caps a slot at the trained context: the window is what it really got.
        const props = (await (await fetch(`${ctx.server.baseUrl}/props`, { headers: { authorization: `Bearer ${ctx.server.apiKey}` }, signal: AbortSignal.timeout(10_000) })).json()) as { default_generation_settings?: { n_ctx?: unknown } };
        const got = Number(props.default_generation_settings?.n_ctx ?? 0);
        if (got > 0 && got < window) {
          ctx.log(`the cal server got ${got} tokens of context, not ${window}: W = ${got}`);
          window = got;
        }
      }
      const cpt = Number(a.chars_per_token);
      const run: Run = {
        ctx,
        send: makeSender(ctx, ctx.server.engine === "locals" ? await localsIds(ctx) : []),
        window,
        prefillTps: Math.min(Number(speed.prefill_tps_2k), Number(speed.prefill_tps_8k)),
        decodeTps: Number(speed.decode_tps),
        cpt: { fact: cpt, aggregate: cpt, bug: cpt },
        overhead: { fact: 0, aggregate: 0, bug: 0 },
      };
      const steps = ctx.harness.steps !== null ? steps0 : gridSteps(window, null);
      const fill: Record<TaskKind, number> = { fact: 0, aggregate: 0, bug: 0 };
      const grid: GridEntry[] = [];
      for (const kind of kinds) {
        // Spec 4.3: start at the top step, step down only on failure; a kind failing at the floor is unfit (0).
        fill[kind] = await walkGrid(
          steps.filter((s) => s + 256 <= window),
          async (tokens) => {
            const ok = await stepPasses(run, kind, tokens, bugThinking, bugJson);
            grid.push(...gridOf(ctx, kind, tokens));
            ctx.log(`Phase B ${kind} at ${tokens} tokens: ${ok ? "pass" : "fail"} (${gridOf(ctx, kind, tokens).map((g) => `${g.counter} ${g.passed}/${g.trials}${g.inconclusive ? `, ${g.inconclusive} inconclusive` : ""}`).join("; ")})`);
            return ok;
          },
        );
      }
      // Output floors (spec 4.3, F15, N4): passing, non-truncated trials only.
      const floors = Object.fromEntries(
        kinds.map((k) => [
          k,
          outputFloor(ctx.progress.trials.filter((t) => t.step.startsWith(`B/${k}/`) && t.outcome === "pass" && t.data?.finish === "stop" && typeof t.data.completion_tokens === "number").map((t) => Number(t.data?.completion_tokens))),
        ]),
      ) as Record<TaskKind, number>;
      const offTokens = shortOffCompletions(ctx.progress.trials);
      const offMode = thinkingOffMode(a.thinking_off === true, offTokens);
      if (offMode === "leaky") ctx.log(`thinking off is leaky: ${offTokens.length} short thinking-off answers have a median over ${LEAKY_LIMIT} completion tokens (thinking_works.off: "leaky", not a failure)`);
      const summary = {
        window_tokens: window,
        free_ram_bytes: w.free,
        fill_fact: fill.fact,
        fill_aggregate: fill.aggregate,
        fill_bug: fill.bug,
        min_out_fact: floors.fact,
        min_out_aggregate: floors.aggregate,
        min_out_bug: floors.bug,
        bug_thinking: bugThinking,
        bug_json: bugJson,
        // D5 (review of a72827f9): the final thinking_works.off, re-judged with Phase B's short thinking-off answers.
        thinking_off_mode: offMode,
        grid: JSON.stringify(grid),
      };
      ctx.record({ step: "B/summary", seed: 0, outcome: "pass", data: summary, at: now() });
      ctx.log(
        `Phase B done: W ${window}; fill_tokens fact ${fill.fact}, aggregate ${fill.aggregate}, bug ${fill.bug} (thinking ${bugThinking}); ` +
          `output floors ${floors.fact}/${floors.aggregate}/${floors.bug}${kinds.filter((k) => fill[k] === 0).map((k) => `; ${k} UNFIT at the floor`).join("")}`,
      );
      return { passed: true };
    } catch (e) {
      if (e instanceof StepPaused) return { passed: false, paused: true, step: e.step, message: e.message };
      if (e instanceof StepFailed) return { passed: false, step: e.step, message: e.message };
      throw e;
    }
  },
};

/** Locals: the ids its /v1/models lists (the sender picks the thinking variant by id). */
async function localsIds(ctx: PhaseContext): Promise<string[]> {
  const res = await fetch(`${ctx.server.baseUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
  const m = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (m.data ?? []).map((d) => d.id).filter((id): id is string => typeof id === "string");
}
