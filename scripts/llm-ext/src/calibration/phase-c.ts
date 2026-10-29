/**
 * calibration/phase-c.ts — Phase C, the server shape (P6;
 * design/specs/local-calibration-design.md section 4.5).
 *
 * Main slots: correctness does not depend on the slot count, so the count is chosen by throughput, not graded
 * trials: n concurrent requests of fill_tokens.fact tokens and 256 output tokens, twice, per candidate; the
 * throughput is the completion tokens of all n replies over the batch wall time, and the smallest n whose throughput
 * is at least 90 % of the best wins. Scouting: the shuffled, de-tagged calibration copy of the scout fixture at each
 * share (tokens per request) and slot count, 3 runs; a run with a timed-out request is repeated, never scored. Every
 * scored candidate goes into the record, and scout_accuracy_threshold is applied when the record is read
 * (scoutingFor in record.ts), so a threshold change needs no new calibration.
 * Memory follows Phase B's rule (main-agent decision 2026-10-29, after review): a candidate that cannot fit the
 * hard budget (total RAM) is skipped; one that fits it but not the free memory now makes the model wait, for at most
 * MEMORY_WAIT_MAX_MS, after which it is skipped too. Neither is ever a failure. Every candidate's result is a trial,
 * so a resume measures only what is missing.
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
import { scoutingFor, TASK_KINDS, type PerKind, type ScoutCandidate } from "./record.js";
import type { Phase } from "./runner.js";

/** Output tokens of each throughput request (spec 4.5). */
export const THROUGHPUT_OUTPUT_TOKENS = 256;
/** Output cap of a scouting request: one short label per record, thinking off. */
export const SCOUT_OUTPUT_CAP = CAP_OFF;
/** Prompt overhead reserved in every slot (spec 4.5: 512). */
const SLOT_OVERHEAD = 512;
/** Scouting runs per candidate (spec 4.5: 3 runs, different seeds). */
const SCOUT_RUNS = 3;
/** Repeats of a scouting run whose request timed out, before the candidate is skipped (review of fb861fab). */
export const SCOUT_TIMEOUT_RERUNS = 2;
/** How long a slot or scouting candidate may wait for free memory before it is skipped (review of fb861fab). */
export const MEMORY_WAIT_MAX_MS = 30 * 60_000;

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
 * The main slot context (spec 4.5), per kind (review of fb861fab): roundup_256(max over k of (fill_tokens[k] + the
 * output cap of k), or the throughput request if larger, + 512). A slot holds one request of one kind, so the largest
 * fill and the largest cap of two different kinds never meet in one slot. The output cap of a kind is
 * max(min_output_tokens[k], the nominal cap of the thinking mode it runs in): a command's own default max_tokens is a
 * per-profile setting calibration cannot know, and the nominal cap is what Phase B proved fits (main-agent decision
 * 2026-10-29; the user may override).
 */
export function mainSlotCtx(fill: PerKind, minOut: PerKind, bugThinking: "on" | "off"): number {
  const cap = (k: (typeof TASK_KINDS)[number]): number => Math.max(minOut[k], k === "bug" && bugThinking === "on" ? CAP_ON : CAP_OFF);
  const need = Math.max(...TASK_KINDS.map((k) => fill[k] + cap(k)), throughputPromptTokens(fill) + THROUGHPUT_OUTPUT_TOKENS);
  return roundup256(need + SLOT_OVERHEAD);
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

/**
 * The parallel throughput of one batch in tok/s (review of fb861fab): every reply's completion tokens over the
 * batch's wall time. A sum of each reply's own predicted_per_second overstates it: each counts only its own decode
 * window, not the time the requests waited for one another. A reply without usage cannot be counted: the step fails.
 */
export function batchThroughput(replies: ReadonlyArray<Pick<Reply, "completionTokens">>, wallMs: number): number {
  const tokens = replies.reduce((s, r) => {
    if (r.completionTokens === null) throw new Error("a throughput reply carries no usage.completion_tokens");
    return s + r.completionTokens;
  }, 0);
  return tokens / Math.max(wallMs / 1000, 0.001);
}

/** Whether a candidate that started waiting for free memory at `since` has waited long enough to be skipped. */
export function memoryWaitExpired(since: string, nowMs: number): boolean {
  return nowMs - Date.parse(since) >= MEMORY_WAIT_MAX_MS;
}

/** A scouting request that hit its deadline: it says nothing about accuracy, so its run is repeated, never scored. */
export function isScoutTimeout(error: string | null): boolean {
  return error !== null && error.startsWith("timeout after");
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
      const waits = (ctx.progress.memoryWait ??= {});

      /**
       * Stop the cal server, then check the shape against memory (as measureWindow does, with the model unloaded).
       * Returns null when it fits, or why it is skipped: over total RAM, or (review of fb861fab) still short of free
       * memory MEMORY_WAIT_MAX_MS after it first waited, so a busy machine cannot hold the model forever. Otherwise
       * the model waits, and the wait start is saved so it survives the runner's passes.
       */
      const fits = async (step: string, slots: number, slotCtx: number): Promise<Record<string, string | number> | null> => {
        await ctx.stopServer(`measuring free memory for ${step}`);
        const { free, floor } = await freeMemory(floorPct);
        const need = weights + kvBytes(layers, slots * slotCtx) + WINDOW_HEADROOM_BYTES;
        const mib = (x: number): number => Math.round(x / 2 ** 20);
        const fit = budgetFit(need, totalmem() - floor, free - floor);
        if (fit === "run") {
          if (waits[step] !== undefined) {
            delete waits[step];
            ctx.save();
          }
          return null;
        }
        if (fit === "skip") {
          ctx.log(`${step}: skipped, ${mib(need)} MiB does not fit total RAM minus the floor (${mib(totalmem() - floor)} MiB)`);
          return { skipped: "memory" };
        }
        const since = waits[step];
        if (since !== undefined && memoryWaitExpired(since, Date.now())) {
          const waited = Math.round((Date.now() - Date.parse(since)) / 60_000);
          delete waits[step];
          ctx.save();
          ctx.log(`${step}: skipped after waiting ${waited} min for free memory (${mib(need)} MiB needed, ${mib(free - floor)} MiB free above the floor)`);
          return { skipped: "memory-wait", waited_min: waited };
        }
        if (since === undefined) {
          waits[step] = now();
          ctx.save();
        }
        const start = waits[step]!;
        throw new WaitForMemory(
          step,
          `${step} needs ${mib(need)} MiB; free memory now allows ${mib(free - floor)} MiB: the model waits for memory (since ${start}; the candidate is skipped at ${new Date(Date.parse(start) + MEMORY_WAIT_MAX_MS).toISOString()} if memory stays short)`,
        );
      };

      // Main slots (spec 4.5).
      const slotCtx = mainSlotCtx(fill, minOut, bugThinking);
      const prompt = throughputPromptTokens(fill);
      for (const n of ctx.harness.mainSlots) {
        const step = `C/main/${n}`;
        if (dataOf(ctx, step)) continue;
        const skip = await fits(step, n, slotCtx);
        if (skip !== null) {
          ctx.record({ step, seed: n, outcome: "pass", data: { slots: n, slot_ctx: slotCtx, ...skip }, at: now() });
          continue;
        }
        await ctx.restart(slotCtx, n);
        const send: Sender = makeSender(ctx, ctx.server.engine === "locals" ? await localsIds(ctx) : []);
        const rates: number[] = [];
        for (let round = 0; round < 2; round++) {
          const t0 = Date.now();
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
          const wallMs = Date.now() - t0;
          const bad = replies.find((r) => r.status !== 200);
          if (bad) throw new Error(`${step}: a throughput request failed: HTTP ${bad.status} ${bad.error ?? ""}`);
          rates.push(batchThroughput(replies, wallMs));
        }
        const tps = Math.round((rates.reduce((s, x) => s + x, 0) / rates.length) * 10) / 10;
        ctx.record({ step, seed: n, outcome: "pass", data: { slots: n, slot_ctx: slotCtx, aggregate_decode_tps: tps, load_avg: loadavg()[0] }, at: now() });
        ctx.log(`Phase C main ${n} slot(s) of ${slotCtx}: parallel throughput ${tps} tok/s (completion tokens over wall time)`);
      }
      const measured = ctx.harness.mainSlots
        .map((n) => dataOf(ctx, `C/main/${n}`))
        .filter((d): d is NonNullable<typeof d> => d !== null && typeof d.aggregate_decode_tps === "number")
        .map((d) => ({ slots: Number(d.slots), tps: Number(d.aggregate_decode_tps), load: Number(d.load_avg) }));
      if (measured.length === 0) return { passed: false, step: "C/main", message: `no main-slot candidate (${ctx.harness.mainSlots.join(", ")}) could run at a slot context of ${slotCtx}: each was over total RAM or waited too long for free memory` };
      const slots = chooseSlots(measured);
      const chosen = measured.find((m) => m.slots === slots)!;

      // Scouting (spec 4.5, F7, A6): json_schema where Phase A proved the 40-item array, else the text path.
      const responseMode = a.array40 === true ? "json_schema" : "text";
      for (const share of ctx.harness.scoutShares) {
        for (const n of ctx.harness.scoutSlots) {
          const step = `C/scout/${share}/${n}`;
          if (dataOf(ctx, step)) continue;
          const sCtx = scoutSlotCtx(share);
          const skip = await fits(step, n, sCtx);
          if (skip !== null) {
            ctx.record({ step, seed: n, outcome: "pass", data: { share, slots: n, slot_ctx: sCtx, ...skip }, at: now() });
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
          let timedOutRuns = 0;
          for (let run = 0; run < SCOUT_RUNS && timedOutRuns === 0; run++) {
            const fixtures = Array.from({ length: n }, (_, i) => calibrationScoutFixture(seed + run * n + i, Math.floor(share * cpt)));
            // A run with a timed-out request is repeated on the same copies (review of fb861fab): a deadline is not an
            // accuracy verdict. After SCOUT_TIMEOUT_RERUNS repeats the candidate is skipped, never scored.
            for (let attempt = 0; ; attempt++) {
              await ctx.waitForTurn();
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
              const timeouts = results.filter((r) => isScoutTimeout(r.error)).length;
              if (timeouts > 0) {
                if (attempt >= SCOUT_TIMEOUT_RERUNS) {
                  timedOutRuns++;
                  break;
                }
                ctx.log(`${step}: run ${run + 1}: ${timeouts} of ${n} request(s) timed out; the run is repeated (${attempt + 1} of ${SCOUT_TIMEOUT_RERUNS})`);
                continue;
              }
              wallMs += Date.now() - t0;
              results.forEach((r, i) => {
                const fx = fixtures[i]!;
                // A failed request (not a timeout) scores every record of it as wrong (positions it never answered).
                if (r.error !== null) errors++;
                correct += scoreAccuracy(fx.expected, r.predicted).correct;
                total += fx.recordCount;
              });
              break;
            }
          }
          if (timedOutRuns > 0) {
            ctx.record({ step, seed, outcome: "pass", data: { share, slots: n, slot_ctx: sCtx, skipped: "timeout" }, at: now() });
            ctx.log(`${step}: skipped, a run still timed out after ${SCOUT_TIMEOUT_RERUNS} repeats; not scored`);
            continue;
          }
          const accuracy = Math.round((correct / total) * 1000) / 1000;
          const rps = Math.round((total / Math.max(wallMs / 1000, 0.001)) * 100) / 100;
          ctx.record({ step, seed, outcome: "pass", data: { share, slots: n, slot_ctx: sCtx, accuracy, records_per_s: rps, records: total, errors, response_mode: responseMode, permutation_seed: seed }, at: now() });
          ctx.log(`Phase C scouting share ${share} at ${n} slots: accuracy ${accuracy} over ${total} records (${errors} failed requests), ${rps} records/s (${responseMode})`);
        }
      }
      // Every scored candidate goes into the record; the threshold is applied when it is read (scoutingFor).
      const candidates: ScoutCandidate[] = ctx.progress.trials
        .filter((t) => t.step.startsWith("C/scout/") && typeof t.data?.accuracy === "number")
        .map((t) => ({ share_tokens: Number(t.data?.share), slots: Number(t.data?.slots), slot_ctx: Number(t.data?.slot_ctx), accuracy: Number(t.data?.accuracy), records_per_s: Number(t.data?.records_per_s), permutation_seed: Number(t.data?.permutation_seed) }));
      const summary = {
        main_slots: slots,
        main_slot_ctx: slotCtx,
        aggregate_decode_tps: chosen.tps,
        load_avg: Math.round(chosen.load * 100) / 100,
        scout_candidates: JSON.stringify(candidates),
      };
      ctx.record({ step: "C/summary", seed: 0, outcome: "pass", data: summary, at: now() });
      // For the log only: the shape the current threshold picks. The record keeps every candidate.
      const threshold = scoutAccuracyThreshold(loadSettings());
      const scouting = scoutingFor(candidates, threshold);
      ctx.log(`Phase C done: main ${slots} slot(s) of ${slotCtx} (${chosen.tps} tok/s parallel); ${candidates.length} scouting candidate(s) scored; at the current threshold ${threshold}: ${scouting === "unfit" ? "unfit" : `share ${scouting.share_tokens} at ${scouting.slots} slots, accuracy ${scouting.accuracy}`}`);
      return { passed: true };
    } catch (e) {
      if (e instanceof WaitForMemory) return { passed: false, paused: true, step: e.step, message: e.message };
      throw e;
    }
  },
};
