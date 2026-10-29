/**
 * calibration/phase-c.ts — Phase C, the server shape (P6;
 * design/specs/local-calibration-design.md section 4.5).
 *
 * Main slots: correctness does not depend on the slot count, so the count is chosen by throughput, not graded
 * trials: n concurrent requests of fill_tokens.fact tokens and 256 output tokens, twice, per candidate; the smallest
 * n whose aggregate decode is at least 90 % of the best wins. Scouting: the shuffled, de-tagged calibration copy of
 * the scout fixture at each share (tokens per request) and slot count, 3 runs; the highest share whose accuracy
 * reaches scout_accuracy_threshold, at the slot count with the best records per second; none: "unfit".
 * Memory follows Phase B's rule (main-agent decision 2026-10-29, after review): a candidate that cannot fit the
 * hard budget (total RAM) is skipped; one that fits it but not the free memory now makes the model wait. Neither
 * is ever a failure. Every candidate's result is a trial, so a resume measures only what is missing.
 */

import { loadavg, totalmem } from "node:os";
import { timingsFromEnv } from "../broker/scheduler.js";
import { loadSettings, scoutAccuracyThreshold } from "../config.js";
import { localsOutgoingModel } from "../local-locals-server.js";
import { buildPositionalSchema, calibrationScoutFixture, classifyPositional, scoreAccuracy } from "../mass_scouting/scout-accuracy-fixture.js";
import { freeMemory, kvBytes, modelKvLayers, WINDOW_HEADROOM_BYTES, weightBytes } from "./memory.js";
import { CAP_OFF, CAP_ON, makeSender, trialTimeoutMs, type Reply, type Sender } from "./phase-a.js";
import { factDocument } from "./phase-b-fixtures.js";
import { dataOf, localsIds } from "./phase-b.js";
import { TASK_KINDS, type PerKind } from "./record.js";
import type { Phase } from "./runner.js";

/** Output tokens of each throughput request (spec 4.5). */
export const THROUGHPUT_OUTPUT_TOKENS = 256;
/** Output cap of a scouting request: one short label per record, thinking off. */
export const SCOUT_OUTPUT_CAP = CAP_OFF;
/** Prompt overhead reserved in every slot (spec 4.5: 512). */
const SLOT_OVERHEAD = 512;
/** Scouting runs per candidate (spec 4.5: 3 runs, different seeds). */
const SCOUT_RUNS = 3;

const roundup256 = (n: number): number => Math.ceil(n / 256) * 256;
const now = (): string => new Date().toISOString();

/**
 * The prompt size of a throughput request: fill_tokens.fact, the size real requests reach (spec 4.5). A model unfit
 * for fact (0) is measured at the 2048-token floor instead (main-agent decision 2026-10-29; the user may override).
 */
export function throughputPromptTokens(fill: PerKind): number {
  return fill.fact > 0 ? fill.fact : 2048;
}

/**
 * The main slot context (spec 4.5): roundup_256(max(fill_tokens) + the largest output cap + 512). The output cap of a
 * kind is max(min_output_tokens[k], the nominal cap of the thinking mode it runs in): a command's own default
 * max_tokens is a per-profile setting calibration cannot know, and the nominal cap is what Phase B proved fits
 * (main-agent decision 2026-10-29; the user may override). The throughput prompt always fits too.
 */
export function mainSlotCtx(fill: PerKind, minOut: PerKind, bugThinking: "on" | "off"): number {
  const cap = (k: (typeof TASK_KINDS)[number]): number => Math.max(minOut[k], k === "bug" && bugThinking === "on" ? CAP_ON : CAP_OFF);
  const outCap = Math.max(...TASK_KINDS.map(cap));
  return roundup256(Math.max(...TASK_KINDS.map((k) => fill[k]), throughputPromptTokens(fill)) + outCap + SLOT_OVERHEAD);
}

/** A scouting slot: the share, the label output and the overhead. */
export function scoutSlotCtx(share: number): number {
  return roundup256(share + SCOUT_OUTPUT_CAP + SLOT_OVERHEAD);
}

/** Spec 4.5: the smallest slot count whose aggregate decode is at least 90 % of the best. */
export function chooseSlots(results: ReadonlyArray<{ slots: number; tps: number }>): number {
  if (results.length === 0) throw new Error("no main-slot candidate was measured");
  const best = Math.max(...results.map((r) => r.tps));
  return Math.min(...results.filter((r) => r.tps >= 0.9 * best).map((r) => r.slots));
}

export interface ScoutResult {
  share: number;
  slots: number;
  slotCtx: number;
  accuracy: number;
  recordsPerS: number;
  seed: number;
}

/** Spec 4.5: the highest passing share; at that share, the slot count with the best records per second; else "unfit". */
export function chooseScouting(results: readonly ScoutResult[], threshold: number): ScoutResult | "unfit" {
  const passing = results.filter((r) => r.accuracy >= threshold);
  if (passing.length === 0) return "unfit";
  const share = Math.max(...passing.map((r) => r.share));
  return passing.filter((r) => r.share === share).reduce((a, b) => (b.recordsPerS > a.recordsPerS ? b : a));
}

/** Whether a server shape fits memory: "skip" over the hard budget (total RAM), "wait" over the soft one (free now). */
export function budgetFit(needBytes: number, hardBudget: number, softBudget: number): "run" | "wait" | "skip" {
  if (needBytes > hardBudget) return "skip";
  if (needBytes > softBudget) return "wait";
  return "run";
}

/** A candidate fits the hard budget but not the free memory now: the model waits (no verdict, no pause counted). */
class WaitForMemory extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
  }
}

/** Aggregate decode tok/s of one batch: the sum of each concurrent reply's own decode rate. */
function aggregateDecode(replies: readonly Reply[]): number {
  return replies.reduce((s, r) => s + (r.predictedPerSecond ?? (r.completionTokens ?? 0) / Math.max(r.wallMs / 1000, 0.001)), 0);
}

export const phaseC: Phase = {
  name: "C",
  run: async (ctx) => {
    const a = dataOf(ctx, "A/summary");
    const b = dataOf(ctx, "B/summary");
    if (!a || !b) return { passed: false, step: "phase-c/needs-ab", message: "Phase C needs the results of Phases A and B" };
    try {
      const cpt = Number(a.chars_per_token);
      const prefillTps = Math.min(Number(a.prefill_tps_2k), Number(a.prefill_tps_8k));
      const decodeTps = Number(a.decode_tps);
      const fill: PerKind = { fact: Number(b.fill_fact), aggregate: Number(b.fill_aggregate), bug: Number(b.fill_bug) };
      const minOut: PerKind = { fact: Number(b.min_out_fact), aggregate: Number(b.min_out_aggregate), bug: Number(b.min_out_bug) };
      const bugThinking = b.bug_thinking === "on" ? "on" : "off";
      const layers = modelKvLayers(ctx.item.engine, ctx.identity.files);
      const weights = weightBytes(ctx.identity.files);
      const floorPct = timingsFromEnv(process.env).memoryFloorPct;

      /** Stop the cal server, then check the shape against memory (as measureWindow does, with the model unloaded). */
      const fits = async (step: string, slots: number, slotCtx: number): Promise<boolean> => {
        await ctx.stopServer(`measuring free memory for ${step}`);
        const { free, floor } = await freeMemory(floorPct);
        const need = weights + kvBytes(layers, slots * slotCtx) + WINDOW_HEADROOM_BYTES;
        const fit = budgetFit(need, totalmem() - floor, free - floor);
        if (fit === "wait") throw new WaitForMemory(step, `${step} needs ${Math.round(need / 2 ** 20)} MiB; free memory now allows ${Math.round((free - floor) / 2 ** 20)} MiB: the model waits for memory`);
        if (fit === "skip") ctx.log(`${step}: skipped, ${Math.round(need / 2 ** 20)} MiB does not fit total RAM minus the floor (${Math.round((totalmem() - floor) / 2 ** 20)} MiB)`);
        return fit === "run";
      };

      // Main slots (spec 4.5).
      const slotCtx = mainSlotCtx(fill, minOut, bugThinking);
      const prompt = throughputPromptTokens(fill);
      for (const n of ctx.harness.mainSlots) {
        const step = `C/main/${n}`;
        if (dataOf(ctx, step)) continue;
        if (!(await fits(step, n, slotCtx))) {
          ctx.record({ step, seed: n, outcome: "pass", data: { slots: n, slot_ctx: slotCtx, skipped: "memory" }, at: now() });
          continue;
        }
        await ctx.restart(slotCtx, n);
        const send: Sender = makeSender(ctx, ctx.server.engine === "locals" ? await localsIds(ctx) : []);
        const rates: number[] = [];
        for (let round = 0; round < 2; round++) {
          const replies = await Promise.all(
            Array.from({ length: n }, (_, i) => {
              const doc = factDocument(7100 + 100 * round + i, Math.floor(prompt * cpt));
              return send.chat([{ role: "user", content: `${doc.text}\n\nDescribe the document above in about 200 words.` }], {
                thinking: "off",
                maxTokens: THROUGHPUT_OUTPUT_TOKENS,
                timeoutMs: trialTimeoutMs(prompt * n, THROUGHPUT_OUTPUT_TOKENS * n, prefillTps, decodeTps),
              });
            }),
          );
          const bad = replies.find((r) => r.status !== 200);
          if (bad) throw new Error(`${step}: a throughput request failed: HTTP ${bad.status} ${bad.error ?? ""}`);
          rates.push(aggregateDecode(replies));
        }
        const tps = Math.round((rates.reduce((s, x) => s + x, 0) / rates.length) * 10) / 10;
        ctx.record({ step, seed: n, outcome: "pass", data: { slots: n, slot_ctx: slotCtx, aggregate_decode_tps: tps, load_avg: loadavg()[0] }, at: now() });
        ctx.log(`Phase C main ${n} slot(s) of ${slotCtx}: aggregate decode ${tps} tok/s`);
      }
      const measured = ctx.harness.mainSlots
        .map((n) => dataOf(ctx, `C/main/${n}`))
        .filter((d): d is NonNullable<typeof d> => d !== null && typeof d.aggregate_decode_tps === "number")
        .map((d) => ({ slots: Number(d.slots), tps: Number(d.aggregate_decode_tps), load: Number(d.load_avg) }));
      if (measured.length === 0) return { passed: false, step: "C/main", message: `no main-slot candidate (${ctx.harness.mainSlots.join(", ")}) fits total RAM at a slot context of ${slotCtx}` };
      const slots = chooseSlots(measured);
      const chosen = measured.find((m) => m.slots === slots)!;

      // Scouting (spec 4.5, F7, A6): json_schema where Phase A proved the 40-item array, else the text path.
      const responseMode = a.array40 === true ? "json_schema" : "text";
      for (const share of ctx.harness.scoutShares) {
        for (const n of ctx.harness.scoutSlots) {
          const step = `C/scout/${share}/${n}`;
          if (dataOf(ctx, step)) continue;
          const sCtx = scoutSlotCtx(share);
          if (!(await fits(step, n, sCtx))) {
            ctx.record({ step, seed: n, outcome: "pass", data: { share, slots: n, slot_ctx: sCtx, skipped: "memory" }, at: now() });
            continue;
          }
          await ctx.restart(sCtx, n);
          const thinkingOff = { chat_template_kwargs: { enable_thinking: false } };
          const model = ctx.server.engine === "locals" ? (localsOutgoingModel(await localsIds(ctx), thinkingOff) ?? ctx.server.model) : ctx.server.model;
          const seed = 9000 + share + n;
          let correct = 0;
          let total = 0;
          let errors = 0;
          let wallMs = 0;
          for (let run = 0; run < SCOUT_RUNS; run++) {
            await ctx.waitForTurn();
            const fixtures = Array.from({ length: n }, (_, i) => calibrationScoutFixture(seed + run * n + i, Math.floor(share * cpt)));
            const t0 = Date.now();
            const results = await Promise.all(
              fixtures.map((fx) =>
                classifyPositional(model, ctx.server.baseUrl, ctx.server.apiKey, fx, buildPositionalSchema(fx.recordCount), {
                  responseMode,
                  extraBody: thinkingOff,
                  maxTokens: SCOUT_OUTPUT_CAP,
                  timeoutMs: trialTimeoutMs(share * n, SCOUT_OUTPUT_CAP * n, prefillTps, decodeTps),
                }),
              ),
            );
            wallMs += Date.now() - t0;
            results.forEach((r, i) => {
              const fx = fixtures[i]!;
              // A failed request scores every record of it as wrong (positions it never answered).
              if (r.error !== null) errors++;
              correct += scoreAccuracy(fx.expected, r.predicted).correct;
              total += fx.recordCount;
            });
          }
          const accuracy = Math.round((correct / total) * 1000) / 1000;
          const rps = Math.round((total / Math.max(wallMs / 1000, 0.001)) * 100) / 100;
          ctx.record({ step, seed, outcome: "pass", data: { share, slots: n, slot_ctx: sCtx, accuracy, records_per_s: rps, records: total, errors, response_mode: responseMode, permutation_seed: seed }, at: now() });
          ctx.log(`Phase C scouting share ${share} at ${n} slots: accuracy ${accuracy} over ${total} records (${errors} failed requests), ${rps} records/s (${responseMode})`);
        }
      }
      const scoutResults: ScoutResult[] = ctx.progress.trials
        .filter((t) => t.step.startsWith("C/scout/") && typeof t.data?.accuracy === "number")
        .map((t) => ({ share: Number(t.data?.share), slots: Number(t.data?.slots), slotCtx: Number(t.data?.slot_ctx), accuracy: Number(t.data?.accuracy), recordsPerS: Number(t.data?.records_per_s), seed: Number(t.data?.permutation_seed) }));
      const threshold = scoutAccuracyThreshold(loadSettings());
      const scouting = chooseScouting(scoutResults, threshold);
      const summary = {
        main_slots: slots,
        main_slot_ctx: slotCtx,
        aggregate_decode_tps: chosen.tps,
        load_avg: Math.round(chosen.load * 100) / 100,
        scouting:
          scouting === "unfit"
            ? "unfit"
            : JSON.stringify({ share_tokens: scouting.share, slots: scouting.slots, slot_ctx: scouting.slotCtx, accuracy: scouting.accuracy, records_per_s: scouting.recordsPerS, permutation_seed: scouting.seed }),
        scout_threshold: threshold,
      };
      ctx.record({ step: "C/summary", seed: 0, outcome: "pass", data: summary, at: now() });
      ctx.log(`Phase C done: main ${slots} slot(s) of ${slotCtx} (${chosen.tps} tok/s aggregate); scouting ${scouting === "unfit" ? `unfit (no share reached ${threshold})` : `share ${scouting.share} at ${scouting.slots} slots, accuracy ${scouting.accuracy}`}`);
      return { passed: true };
    } catch (e) {
      if (e instanceof WaitForMemory) return { passed: false, paused: true, step: e.step, message: e.message };
      throw e;
    }
  },
};
