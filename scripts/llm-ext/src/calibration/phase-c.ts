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
 * hard budget (total RAM minus the floor) is skipped for good under that floor; one that fits it but not the free
 * memory now makes the model wait, for at most MEMORY_WAIT_MAX_MS, after which it is skipped for this pass only
 * (inconclusive), like a scouting candidate whose runs keep timing out. Rule A (coordinator decision 2026-10-29): an
 * inconclusive candidate is measured again on later passes, and Phase C pauses (no verdict, no record) while any main
 * or scouting candidate is pending; after INCONCLUSIVE_PASSES passes it is given up. Then Phase C decides from the
 * scored candidates: no main slot scored, every one over total RAM, is a model too big for this machine's memory (a
 * calibration-failed record, rule 1); no main slot scored with any one given up after its memory waits is memory-limited
 * (rule 2, no verdict); no scouting candidate scored makes scouting unfit with the
 * reason, and the model stays usable. Every candidate's result is a trial, so a resume measures only what is missing.
 */

import { loadavg, totalmem } from "node:os";
import { timingsFromEnv } from "../broker/scheduler.js";
import { loadSettings, scoutAccuracyThreshold } from "../config.js";
import { localsOutgoingModel } from "../local-locals-server.js";
import { buildPositionalSchema, calibrationScoutFixture, classifyPositional, scoreAccuracy, SCOUT_HTTP_PREFIX, SCOUT_NETWORK_PREFIX, SCOUT_TIMEOUT_PREFIX } from "../mass_scouting/scout-accuracy-fixture.js";
import { freeMemory, kvBytes, modelKvLayers, WINDOW_HEADROOM_BYTES, weightBytes } from "./memory.js";
import { CAP_OFF, CAP_ON, makeSender, trialTimeoutMs, type Reply, type Sender } from "./phase-a.js";
import { factDocument } from "./phase-b-fixtures.js";
import { dataOf, localsIds } from "./phase-b.js";
import { scoutingFor, TASK_KINDS, type PerKind, type ScoutCandidate } from "./record.js";
import type { Phase } from "./runner.js";
import { budgetFit, INCONCLUSIVE_PASSES, MEMORY_WAIT_CAUSE, MEMORY_WAIT_GIVEN_UP, memoryWaitCheck, memoryWaitClear, recordInconclusiveSkip, WaitForMemory } from "./memory-wait.js";

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

/** Why a candidate is pending, for the log and `calibration-status` (rule A: shown with "pass k of 3"). */
export function pendingCause(skipped: string): string {
  if (skipped === "timeout") return "a scouting run timed out after its reruns";
  if (skipped === "transport") return "a scouting run lost its connection (reset, or HTTP 502/503/504) after its reruns";
  if (skipped === "memory-wait") return MEMORY_WAIT_CAUSE;
  throw new Error(`unknown pending Phase C skip '${skipped}'`);
}
/** What a terminal skip means, in the words of the failure message and the scouting unfit reason. */
export function skipText(skipped: string): string {
  if (skipped === "memory") return "over total RAM";
  if (skipped === "memory-wait") return MEMORY_WAIT_GIVEN_UP;
  if (skipped === "timeout") return `timed out on ${INCONCLUSIVE_PASSES} passes`;
  if (skipped === "transport") return `lost its connection on ${INCONCLUSIVE_PASSES} passes`;
  throw new Error(`unknown Phase C skip '${skipped}'`);
}

/**
 * Why scouting is unfit when every candidate ended unscored (coordinator decisions 2026-10-29): over total RAM, or
 * given up after INCONCLUSIVE_PASSES passes of memory waits, timeouts or lost connections, joined by "or". Kept in the record so it
 * never reads as an accuracy failure.
 */
export function scoutUnfitReason(skips: readonly string[]): string {
  return [...new Set(skips.map(skipText))].join(" or ");
}

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

/** Spec 4.5: the smallest slot count whose parallel throughput (aggregate_tps) is at least 90 % of the best. */
export function chooseSlots(results: ReadonlyArray<{ slots: number; tps: number }>): number {
  if (results.length === 0) throw new Error("no main-slot candidate was measured");
  const best = Math.max(...results.map((r) => r.tps));
  return Math.min(...results.filter((r) => r.tps >= 0.9 * best).map((r) => r.slots));
}

/**
 * The parallel throughput of one batch in tok/s (review of fb861fab): every reply's completion tokens over the
 * batch's wall time. A sum of each reply's own predicted_per_second overstates it: each counts only its own decode
 * window, not the time the requests waited for one another. A reply without usage cannot be counted: this throws, and
 * the runner counts the throw as a crash of the model (the third crash writes a calibration-failed runner/error record).
 */
export function batchThroughput(replies: ReadonlyArray<Pick<Reply, "completionTokens">>, wallMs: number): number {
  const tokens = replies.reduce((s, r) => {
    if (r.completionTokens === null) throw new Error("a throughput reply carries no usage.completion_tokens");
    return s + r.completionTokens;
  }, 0);
  return tokens / Math.max(wallMs / 1000, 0.001);
}
/** A scouting request that hit its deadline: it says nothing about accuracy, so its run is repeated, never scored. */
export function isScoutTimeout(error: string | null): boolean {
  return error !== null && error.startsWith(SCOUT_TIMEOUT_PREFIX);
}

/** HTTP statuses a loaded server or a proxy gives when it cannot take the request now: load, not the model. */
const LOAD_HTTP_STATUSES: readonly number[] = [502, 503, 504];

/**
 * A scouting request lost to load, not answered by the model (review of a3862052, MINOR-6): a dropped connection (no
 * reply at all: a reset, a socket hang up) or HTTP 502/503/504. Like a timeout it says nothing about accuracy, so its
 * run is repeated and never scored all-wrong. A real error of the model (a bad reply, HTTP 400 or 500) is scored.
 */
export function isScoutTransportFailure(error: string | null): boolean {
  if (error === null) return false;
  if (error.startsWith(SCOUT_NETWORK_PREFIX)) return true;
  if (!error.startsWith(SCOUT_HTTP_PREFIX)) return false;
  return LOAD_HTTP_STATUSES.includes(Number.parseInt(error.slice(SCOUT_HTTP_PREFIX.length), 10));
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

      /**
       * A candidate's terminal result: its latest trial with outcome pass, that is measured, skipped as over total RAM
       * under the memory floor in force now (review of 2411e6dc, finding 11: a different floor re-checks it), or given
       * up after INCONCLUSIVE_PASSES passes. Otherwise null, and the candidate is measured again on this pass.
       */
      const finished = (step: string): ReturnType<typeof dataOf> => {
        const t = [...ctx.progress.trials].reverse().find((x) => x.step === step);
        if (t?.outcome !== "pass" || !t.data) return null;
        if (t.data.skipped === "memory" && t.data.floor_pct !== floorPct) return null;
        return t.data;
      };
      /**
       * Record a skip (rule A, coordinator decision 2026-10-29). Over total RAM is terminal, with the floor it was judged
       * against. A memory-wait, timeout or transport skip is inconclusive until its INCONCLUSIVE_PASSES-th pass
       * (recordInconclusiveSkip, shared with Phase B).
       */
      const recordSkip = (step: string, seed: number, base: Record<string, number>, skip: Record<string, string | number>): void => {
        if (skip.skipped === "memory") {
          ctx.record({ step, seed, outcome: "pass", data: { ...base, ...skip, floor_pct: floorPct }, at: now() });
          return;
        }
        recordInconclusiveSkip(ctx, step, seed, { ...base, ...skip }, pendingCause(String(skip.skipped)));
      };

      /**
       * Stop the cal server, then check the shape against memory (as measureWindow does, with the model unloaded).
       * Returns null when it fits, or why it is skipped: over total RAM, or (review of fb861fab) still short of free
       * memory after MEMORY_WAIT_MAX_MS of checks, so a busy machine cannot hold the model forever. Otherwise the model
       * waits (memoryWaitCheck throws WaitForMemory; the wait is saved for memoryWaitPrecheck).
       */
      const fits = async (step: string, slots: number, slotCtx: number): Promise<Record<string, string | number> | null> => {
        await ctx.stopServer(`measuring free memory for ${step}`);
        const { free, floor } = await freeMemory(floorPct);
        const need = weights + kvBytes(layers, slots * slotCtx) + WINDOW_HEADROOM_BYTES;
        const mib = (x: number): number => Math.round(x / 2 ** 20);
        const fit = budgetFit(need, totalmem() - floor, free - floor);
        // MINOR-8 (review of a3862052): a fit or a skip over total RAM ends an earlier wait of this candidate.
        if (fit !== "wait") memoryWaitClear(ctx, step);
        if (fit === "run") return null;
        if (fit === "skip") {
          ctx.log(`${step}: skipped, ${mib(need)} MiB does not fit total RAM minus the floor (${mib(totalmem() - floor)} MiB)`);
          return { skipped: "memory" };
        }
        return memoryWaitCheck(ctx, step, need, free, floor);
      };

      // Main slots (spec 4.5).
      const slotCtx = mainSlotCtx(fill, minOut, bugThinking);
      const prompt = throughputPromptTokens(fill);
      for (const n of ctx.harness.mainSlots) {
        const step = `C/main/${n}`;
        if (finished(step)) continue;
        const skip = await fits(step, n, slotCtx);
        if (skip !== null) {
          recordSkip(step, n, { slots: n, slot_ctx: slotCtx }, skip);
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
        ctx.record({ step, seed: n, outcome: "pass", data: { slots: n, slot_ctx: slotCtx, aggregate_tps: tps, load_avg: loadavg()[0] }, at: now() });
        ctx.log(`Phase C main ${n} slot(s) of ${slotCtx}: parallel throughput ${tps} tok/s (completion tokens over wall time)`);
      }
      const mainSteps = ctx.harness.mainSlots.map((n) => `C/main/${n}`);
      const measured = mainSteps
        .map((s) => finished(s))
        .filter((d): d is NonNullable<typeof d> => d !== null && typeof d.aggregate_tps === "number")
        .map((d) => ({ slots: Number(d.slots), tps: Number(d.aggregate_tps), load: Number(d.load_avg) }));
      // No main-slot candidate scored and none pending: every one is over total RAM or was given up (coordinator
      // decisions 2026-10-29). Every one over total RAM: the model is too big for this machine's memory (rule 1), a
      // calibration-failed record that stores what it was judged against. Any one given up after its memory waits could
      // have fit: the calibration is memory-limited, no verdict (rule 2). A pending one pauses below instead.
      if (measured.length === 0 && mainSteps.every((s) => finished(s) !== null)) {
        const skips = mainSteps.map((s) => String(finished(s)?.skipped));
        const text = mainSteps.map((s, i) => `${s} ${skipText(skips[i]!)}`).join(", ");
        if (skips.every((s) => s === "memory")) {
          const nCtxTrain = Number(dataOf(ctx, "A/capabilities")?.n_ctx_train ?? 0);
          return {
            passed: false,
            step: "C/main",
            message: `the model is too big for this machine's memory: no main-slot candidate fits total RAM ${Math.round(totalmem() / 2 ** 20)} MiB minus the ${floorPct} % floor (${text})`,
            memory: { kind: "too-big", judged: { total_ram_bytes: totalmem(), floor_pct: floorPct, n_ctx_train: nCtxTrain } },
          };
        }
        if (skips.every((s) => s === "memory" || s === "memory-wait")) return { passed: false, step: "C/main", message: `no main-slot candidate could be measured for lack of free memory: ${text}`, memory: { kind: "memory-limited" } };
        return { passed: false, step: "C/main", message: `no main-slot candidate could be measured: ${text}` };
      }

      // Scouting (spec 4.5, F7, A6): json_schema where Phase A proved the 40-item array, else the text path.
      const responseMode = a.array40 === true ? "json_schema" : "text";
      for (const share of ctx.harness.scoutShares) {
        for (const n of ctx.harness.scoutSlots) {
          const step = `C/scout/${share}/${n}`;
          if (finished(step)) continue;
          const sCtx = scoutSlotCtx(share);
          const skip = await fits(step, n, sCtx);
          if (skip !== null) {
            recordSkip(step, n, { share, slots: n, slot_ctx: sCtx }, skip);
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
          // Why the candidate ended unscored on this pass: a run still timing out or losing its connection after its
          // reruns, or a memory skip found by the re-check before a rerun. null while it can still be scored.
          let unscored: Record<string, string | number> | null = null;
          for (let run = 0; run < SCOUT_RUNS && unscored === null; run++) {
            const fixtures = Array.from({ length: n }, (_, i) => calibrationScoutFixture(seed + run * n + i, Math.floor(share * cpt)));
            // A run with a request that timed out or was lost to load (a dropped connection, HTTP 502/503/504) is
            // repeated on the same copies (review of fb861fab; review of a3862052, MINOR-6): neither is an accuracy
            // verdict. After SCOUT_TIMEOUT_RERUNS repeats the candidate is skipped for this pass, never scored (rule A).
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
              const lost = results.filter((r) => isScoutTransportFailure(r.error)).length;
              if (timeouts + lost > 0) {
                if (attempt >= SCOUT_TIMEOUT_RERUNS) {
                  unscored = { skipped: timeouts > 0 ? "timeout" : "transport" };
                  break;
                }
                ctx.log(`${step}: run ${run + 1}: ${timeouts} of ${n} request(s) timed out and ${lost} lost the connection; the run is repeated (${attempt + 1} of ${SCOUT_TIMEOUT_RERUNS})`);
                // MINOR-6: a busy machine is the likely cause, so memory is checked again before the rerun, exactly as
                // before the first run: over total RAM or a memory wait ends this candidate's pass the usual way.
                const skip = await fits(step, n, sCtx);
                if (skip !== null) {
                  unscored = skip;
                  break;
                }
                await ctx.restart(sCtx, n);
                continue;
              }
              wallMs += Date.now() - t0;
              results.forEach((r, i) => {
                const fx = fixtures[i]!;
                // A real error of the model (a bad reply, HTTP 400 or 500) scores every record of it as wrong.
                if (r.error !== null) errors++;
                correct += scoreAccuracy(fx.expected, r.predicted).correct;
                total += fx.recordCount;
              });
              break;
            }
          }
          if (unscored !== null) {
            recordSkip(step, seed, { share, slots: n, slot_ctx: sCtx }, unscored);
            continue;
          }
          const accuracy = Math.round((correct / total) * 1000) / 1000;
          const rps = Math.round((total / Math.max(wallMs / 1000, 0.001)) * 100) / 100;
          ctx.record({ step, seed, outcome: "pass", data: { share, slots: n, slot_ctx: sCtx, accuracy, records_per_s: rps, records: total, errors, response_mode: responseMode, permutation_seed: seed }, at: now() });
          ctx.log(`Phase C scouting share ${share} at ${n} slots: accuracy ${accuracy} over ${total} records (${errors} failed requests), ${rps} records/s (${responseMode})`);
        }
      }
      // Rule A (coordinator decision 2026-10-29, review of 2411e6dc findings 2 and 3): no final record while any main or
      // scouting candidate is still pending, so a busy moment never decides the slot count or the scouting shape. A
      // candidate stops pending once measured, over total RAM, or given up after INCONCLUSIVE_PASSES passes.
      const scoutSteps = ctx.harness.scoutShares.flatMap((share) => ctx.harness.scoutSlots.map((n) => `C/scout/${share}/${n}`));
      const pending = [...mainSteps, ...scoutSteps].filter((s) => finished(s) === null);
      if (pending.length > 0) {
        return {
          passed: false,
          paused: true,
          step: pending[0]!,
          message: `${pending.join(", ")} not measured yet (a memory wait or a timeout, measured again on the next pass; given up after ${INCONCLUSIVE_PASSES} passes): Phase C writes no record until then`,
        };
      }
      const slots = chooseSlots(measured);
      const chosen = measured.find((m) => m.slots === slots)!;
      // With no scored scouting candidate, scouting is unfit with the reason, and the model stays usable for the rest.
      const scored = scoutSteps.some((s) => typeof finished(s)?.accuracy === "number");
      const unfitReason = scored ? null : scoutUnfitReason(scoutSteps.map((s) => String(finished(s)?.skipped)));
      // Every scored candidate goes into the record; the threshold is applied when it is read (scoutingFor).
      const candidates: ScoutCandidate[] = ctx.progress.trials
        .filter((t) => t.step.startsWith("C/scout/") && typeof t.data?.accuracy === "number")
        .map((t) => ({ share_tokens: Number(t.data?.share), slots: Number(t.data?.slots), slot_ctx: Number(t.data?.slot_ctx), accuracy: Number(t.data?.accuracy), records_per_s: Number(t.data?.records_per_s), permutation_seed: Number(t.data?.permutation_seed) }));
      const summary = {
        main_slots: slots,
        main_slot_ctx: slotCtx,
        aggregate_tps: chosen.tps,
        load_avg: Math.round(chosen.load * 100) / 100,
        scout_candidates: JSON.stringify(candidates),
        ...(unfitReason !== null ? { scouting_unfit_reason: unfitReason } : {}),
      };
      ctx.record({ step: "C/summary", seed: 0, outcome: "pass", data: summary, at: now() });
      // For the log only: the shape the current threshold picks. The record keeps every candidate.
      const threshold = scoutAccuracyThreshold(loadSettings());
      const scouting = scoutingFor(candidates, threshold);
      ctx.log(`Phase C done: main ${slots} slot(s) of ${slotCtx} (${chosen.tps} tok/s parallel); ${candidates.length} scouting candidate(s) scored; ${unfitReason !== null ? `scouting unfit: ${unfitReason}` : `at the current threshold ${threshold}: ${scouting === "unfit" ? "unfit" : `share ${scouting.share_tokens} at ${scouting.slots} slots, accuracy ${scouting.accuracy}`}`}`);
      return { passed: true };
    } catch (e) {
      if (e instanceof WaitForMemory) return { passed: false, paused: true, step: e.step, message: e.message };
      throw e;
    }
  },
};
