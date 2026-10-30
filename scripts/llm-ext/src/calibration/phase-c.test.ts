/**
 * phase-c.test.ts — Phase C's choices and the scouting path (P6; design/specs/local-calibration-design.md
 * sections 4.5 and 9). The classifier runs against a real HTTP server on 127.0.0.1 that answers like a model would;
 * the slot, scouting and record choices are pure functions over measured numbers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPositionalSchema,
  calibrationScoutFixture,
  classifyPositional,
  generateFixtureRecords,
  MIN_FIXTURE_BYTES,
  MIN_FIXTURE_RECORDS,
  NEUTRAL_TAGS,
  parsePositionalText,
  SCOUT_CATEGORIES,
  scoreAccuracy,
  type ScoutFixture,
} from "../mass_scouting/scout-accuracy-fixture.js";
import { CAP_OFF, CAP_ON } from "./phase-a.js";
import { budgetFit, INCONCLUSIVE_PASSES, MEMORY_WAIT_GAP_MS, MEMORY_WAIT_MAX_MS, memoryWaitExpired, memoryWaitPrecheck, memoryWaitTick } from "./memory-wait.js";
import { batchThroughput, chooseSlots, isScoutTimeout, isScoutTransportFailure, mainSlotCtx, phaseC, scoutSlotCtx, scoutUnfitReason, THROUGHPUT_OUTPUT_TOKENS, throughputPromptTokens } from "./phase-c.js";
import { FIXTURE_VERSION, HARNESS_VERSION, okRecordFrom, PRODUCTION_HARNESS_ID, recordSchemaErrors, scoutingFor, writeRecord, type RecordBase, type ScoutCandidate } from "./record.js";
import { writeGguf } from "./test-gguf.js";
import { calibrationStatusText } from "./commands.js";
import { recordFixture } from "./test-record.js";
import type { Profile } from "../config.js";
import { freeMemory, kvBytes, modelKvLayers, WINDOW_HEADROOM_BYTES, weightBytes } from "./memory.js";
import type { PhaseContext } from "./runner.js";
import { enqueueUnlocked, loadProgress, saveProgress, type MemoryWait, type TrialRecord } from "./state.js";
import { timingsFromEnv } from "../broker/scheduler.js";

/** The records of a fixture body, split at each frontmatter block. */
const recordsOf = (fx: ScoutFixture): string[] => fx.body.split(/^---\nname: /m).slice(1);
const tagsOf = (rec: string): string[] => (/-- (.*)$/m.exec(rec)?.[1] ?? "").split(" ").filter((t) => t.startsWith("#"));

/** Degenerate answerers (spec 9): each must score near chance on the calibration copy. */
const constant = (fx: ScoutFixture): string[] => Array.from({ length: fx.recordCount }, () => "debugging");
const fromTags = (fx: ScoutFixture): string[] =>
  recordsOf(fx).map((rec) => {
    const t = tagsOf(rec)[0]?.slice(1) ?? "";
    return (SCOUT_CATEGORIES as readonly string[]).includes(t) ? t : SCOUT_CATEGORIES[t.length % SCOUT_CATEGORIES.length]!;
  });
/** "The label cycle copied from the first records": the first 10 labels, read off a cheat, then repeated. */
const cycleCopied = (fx: ScoutFixture): string[] => Array.from({ length: fx.recordCount }, (_, i) => fx.expected[i % 10]!);

describe("the calibration copy of the scout fixture (spec 4.5, F7, A6)", () => {
  it("is deterministic, balanced, shuffled by its seed, never under 40 records, and carries only neutral tags", () => {
    const a = calibrationScoutFixture(9001, MIN_FIXTURE_BYTES);
    expect(calibrationScoutFixture(9001, MIN_FIXTURE_BYTES)).toEqual(a);
    expect(calibrationScoutFixture(9002, MIN_FIXTURE_BYTES).expected).not.toEqual(a.expected);
    expect(a.recordCount).toBe(MIN_FIXTURE_RECORDS);
    expect(calibrationScoutFixture(1, 10).recordCount).toBe(MIN_FIXTURE_RECORDS);
    expect(calibrationScoutFixture(1, 2 * MIN_FIXTURE_BYTES).recordCount).toBe(2 * MIN_FIXTURE_RECORDS);
    for (const c of SCOUT_CATEGORIES) expect(a.expected.filter((x) => x === c)).toHaveLength(4);
    expect(a.expected).not.toEqual(generateFixtureRecords(9001, 40).expected);
    for (const rec of recordsOf(a)) for (const t of tagsOf(rec)) expect(NEUTRAL_TAGS as readonly string[]).toContain(t);
    expect(recordsOf(a)).toHaveLength(a.recordCount);
  });
  it("degenerate answerers score near chance on it (constant, label cycle, labels copied from the tags), but not on the production fixture", () => {
    const copies = [9001, 9002, 9003].map((s) => calibrationScoutFixture(s, MIN_FIXTURE_BYTES));
    // Chance is 0.1 and the pass line 0.95. The cycle answerers copy the first 10 labels (they are right there by
    // construction), so they are judged on the records after them.
    const accuracy = (answer: (fx: ScoutFixture) => string[], from: number): number =>
      copies.reduce((s, fx) => s + scoreAccuracy(fx.expected.slice(from), answer(fx).slice(from)).correct, 0) / copies.reduce((s, fx) => s + fx.recordCount - from, 0);
    for (const answer of [constant, fromTags]) expect(accuracy(answer, 0)).toBeLessThan(0.25);
    expect(accuracy(cycleCopied, 10)).toBeLessThan(0.25);
    // On the production fixture (i % 10 order, category hashtags) the cycle and the tags give the answer away.
    const prod = generateFixtureRecords(1, 40);
    expect(scoreAccuracy(prod.expected, cycleCopied(prod)).accuracy).toBe(1);
    expect(scoreAccuracy(prod.expected, fromTags(prod)).accuracy).toBe(1);
  });
});

describe("parsePositionalText (the text path, P6; P8 and P9 reuse it)", () => {
  it("finds the categories in a bare object, a fenced block, prose around it, after a think block, or a bare array", () => {
    const want = { categories: ["docs", "ui"] };
    expect(parsePositionalText('{"categories": ["docs", "ui"]}')).toEqual(want);
    expect(parsePositionalText('```json\n{"categories": ["Docs", " ui "]}\n```')).toEqual(want);
    expect(parsePositionalText('Here they are: {"categories": ["docs","ui"]} Hope this helps.')).toEqual(want);
    expect(parsePositionalText('<think>maybe {"categories": ["data"]}</think>\n{"categories": ["docs","ui"]}')).toEqual(want);
    expect(parsePositionalText('reasoning without an opening tag</think>{"categories": ["docs","ui"]}')).toEqual(want);
    expect(parsePositionalText('["docs", "ui"]')).toEqual(want);
  });
  it("is an error, never a guess: no JSON, no categories array, or a non-string entry that would shift positions", () => {
    expect(parsePositionalText("docs, ui")).toHaveProperty("error");
    expect(parsePositionalText('{"labels": ["docs"]}')).toHaveProperty("error");
    expect(parsePositionalText('{"categories": ["docs", 3, "ui"]}')).toHaveProperty("error");
  });
});

describe("classifyPositional against a real HTTP server: the text path and the json_schema path", () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
  });
  /** A server that answers every chat request with `reply(body)` as the message content, and keeps every body. */
  const serve = async (reply: (body: Record<string, unknown>) => string): Promise<{ url: string; bodies: Array<Record<string, unknown>> }> => {
    const bodies: Array<Record<string, unknown>> = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (d: Buffer) => (raw += d.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: reply(body) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
  };

  for (const [name, fx] of [
    ["the real scout fixture", generateFixtureRecords(1, 40)],
    ["the calibration copy", calibrationScoutFixture(9001, MIN_FIXTURE_BYTES)],
  ] as const) {
    it(`text path on ${name}: no response_format, the schema in the prompt, a think block and a fence in the reply, every label read in order`, async () => {
      const { url, bodies } = await serve(() => `<think>let me look</think>\nSure:\n\`\`\`json\n${JSON.stringify({ categories: fx.expected })}\n\`\`\``);
      const r = await classifyPositional("m", url, "k", fx, buildPositionalSchema(fx.recordCount), { responseMode: "text", extraBody: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: CAP_OFF, timeoutMs: 10_000 });
      expect(r.error).toBeNull();
      expect(scoreAccuracy(fx.expected, r.predicted).accuracy).toBe(1);
      expect(bodies[0]).not.toHaveProperty("response_format");
      expect(bodies[0]).toMatchObject({ max_tokens: CAP_OFF, chat_template_kwargs: { enable_thinking: false } });
      const system = (bodies[0]!.messages as Array<{ role: string; content: string }>)[0]!.content;
      expect(system).toContain("JSON Schema");
      expect(system).toContain(`"minItems":${fx.recordCount}`);
    });
  }
  it("json_schema path (default) keeps response_format and strict JSON parsing", async () => {
    const fx = generateFixtureRecords(1, 40);
    const { url, bodies } = await serve(() => JSON.stringify({ categories: fx.expected }));
    const r = await classifyPositional("m", url, "k", fx, buildPositionalSchema(fx.recordCount), { timeoutMs: 10_000 });
    expect(scoreAccuracy(fx.expected, r.predicted).accuracy).toBe(1);
    expect(bodies[0]).toHaveProperty("response_format");
    const { url: url2 } = await (async () => {
      await new Promise<void>((res) => server!.close(() => res()));
      return serve(() => `<think>x</think>${JSON.stringify({ categories: fx.expected })}`);
    })();
    expect((await classifyPositional("m", url2, "k", fx, buildPositionalSchema(fx.recordCount), { timeoutMs: 10_000 })).error).toMatch(/JSON.parse/);
  });
  it("a text reply with no parsable list is a failed request (every record of it scores wrong)", async () => {
    const fx = calibrationScoutFixture(9001, MIN_FIXTURE_BYTES);
    const { url } = await serve(() => "I think they are mostly about debugging.");
    const r = await classifyPositional("m", url, "k", fx, buildPositionalSchema(fx.recordCount), { responseMode: "text", timeoutMs: 10_000 });
    expect(r.error).toMatch(/no JSON/);
    expect(scoreAccuracy(fx.expected, r.predicted).correct).toBe(0);
  });
});

describe("Phase C choices (spec 4.5)", () => {
  it("slot selection: the smallest slot count within 90 % of the best parallel throughput", () => {
    expect(chooseSlots([{ slots: 1, tps: 100 }, { slots: 2, tps: 180 }, { slots: 4, tps: 200 }, { slots: 8, tps: 205 }])).toBe(4);
    expect(chooseSlots([{ slots: 1, tps: 100 }, { slots: 2, tps: 95 }])).toBe(1);
    expect(chooseSlots([{ slots: 2, tps: 50 }])).toBe(2);
    expect(() => chooseSlots([])).toThrow(/no main-slot candidate/);
  });
  it("the main slot context, per kind: max over k of (fill_k + cap_k), or the throughput request, + 512, rounded up to 256", () => {
    expect(CAP_OFF).toBe(2048);
    expect(CAP_ON).toBe(8192);
    const fill = { fact: 13107, aggregate: 8192, bug: 4096 };
    // Thinking-on bug: fact 13107 + 2048 = 15155 beats bug 4096 + 8192 = 12288; 15155 + 512 = 15667, rounded 15872.
    // The old rule (largest fill + largest cap of different kinds) would give 13107 + 8192 + 512, rounded 22016.
    expect(mainSlotCtx(fill, { fact: 512, aggregate: 768, bug: 4096 }, "on")).toBe(15872);
    expect(mainSlotCtx(fill, { fact: 512, aggregate: 768, bug: 4096 }, "off")).toBe(15872);
    expect(mainSlotCtx(fill, { fact: 0, aggregate: 0, bug: 0 }, "off")).toBe(15872);
    // A kind with its own large cap decides: bug 8192 + 8192 = 16384, + 512 = 16896.
    expect(mainSlotCtx({ fact: 2048, aggregate: 2048, bug: 8192 }, { fact: 0, aggregate: 0, bug: 0 }, "on")).toBe(16896);
    // min_output_tokens above the nominal cap is that kind's cap: aggregate 8192 + 6000 = 14192, + 512 = 14704 -> 14848.
    expect(mainSlotCtx({ fact: 4096, aggregate: 8192, bug: 0 }, { fact: 0, aggregate: 6000, bug: 0 }, "off")).toBe(14848);
    expect(throughputPromptTokens({ fact: 0, aggregate: 4096, bug: 0 })).toBe(2048);
    // Everything unfit: the throughput request (2048 + 256) is the largest, + 512 = 2816.
    expect(mainSlotCtx({ fact: 0, aggregate: 0, bug: 0 }, { fact: 0, aggregate: 0, bug: 0 }, "off")).toBe(2048 + THROUGHPUT_OUTPUT_TOKENS + 512);
    expect(scoutSlotCtx(2048)).toBe(2048 + CAP_OFF + 512);
  });
  it("scouting at a threshold, applied when the record is read: the highest passing share, at its fastest slot count; none passing is unfit", () => {
    const r = (share: number, slots: number, accuracy: number, rps: number): ScoutCandidate => ({ share_tokens: share, slots, slot_ctx: scoutSlotCtx(share), accuracy, records_per_s: rps, permutation_seed: 1 });
    const measured = [r(2048, 4, 0.97, 10), r(2048, 8, 0.96, 14), r(4096, 4, 0.95, 9), r(4096, 8, 0.95, 12)];
    expect(scoutingFor(measured, 0.95)).toMatchObject({ share_tokens: 4096, slots: 8 });
    // The same record at a stricter threshold picks another shape: no new calibration is needed.
    expect(scoutingFor(measured, 0.965)).toMatchObject({ share_tokens: 2048, slots: 4 });
    expect(scoutingFor(measured, 0.99)).toBe("unfit");
    expect(scoutingFor([r(2048, 4, 0.97, 10), r(4096, 8, 0.9, 30)], 0.95)).toMatchObject({ share_tokens: 2048, slots: 4 });
    expect(scoutingFor([], 0.5)).toBe("unfit");
  });
  it("memory: over total RAM is skipped, over the free memory now waits, never a verdict; a wait expires after 30 minutes of checks", () => {
    expect(budgetFit(10, 20, 15)).toBe("run");
    expect(budgetFit(16, 20, 15)).toBe("wait");
    expect(budgetFit(21, 20, 30)).toBe("skip");
    expect(MEMORY_WAIT_MAX_MS).toBe(30 * 60_000);
    const t = Date.parse("2026-10-29T10:00:00.000Z");
    // Checks a minute apart for 30 minutes: the wait is over.
    let w = memoryWaitTick(undefined, 7, t);
    expect(w).toEqual({ since: "2026-10-29T10:00:00.000Z", seen: "2026-10-29T10:00:00.000Z", waited_ms: 0, need: 7 });
    for (let m = 1; m < 30; m++) w = memoryWaitTick(w, 7, t + m * 60_000);
    expect(memoryWaitExpired(w)).toBe(false);
    expect(memoryWaitExpired(memoryWaitTick(w, 7, t + 30 * 60_000))).toBe(true);
    // MINOR-7 (review of a3862052): a night with no runner checking adds nothing, so the next check is not an expiry.
    const morning = memoryWaitTick(memoryWaitTick(undefined, 7, t), 7, t + 10 * 3_600_000);
    expect(morning).toMatchObject({ since: "2026-10-29T10:00:00.000Z", waited_ms: 0 });
    expect(memoryWaitExpired(morning)).toBe(false);
    expect(memoryWaitTick(memoryWaitTick(undefined, 7, t), 7, t + MEMORY_WAIT_GAP_MS).waited_ms).toBe(MEMORY_WAIT_GAP_MS);
  });
  it("parallel throughput: all completion tokens over the batch wall time, not a sum of per-reply rates; no usage fails", () => {
    // Two replies of 256 tokens in 4 s of wall time: 128 tok/s, whatever each reply reports as its own decode rate.
    expect(batchThroughput([{ completionTokens: 256 }, { completionTokens: 256 }], 4000)).toBe(128);
    expect(() => batchThroughput([{ completionTokens: 256 }, { completionTokens: null }], 4000)).toThrow(/no usage.completion_tokens/);
  });
});

describe("the ok record (spec 7) from the three phase summaries", () => {
  const base: RecordBase = {
    harness: `custom:${"c".repeat(64)}`,
    harness_version: 2,
    fixture_version: 1,
    engine: "llama",
    model: "a/b:Q4",
    fingerprint: { blobs: ["0".repeat(64)], ram_bytes: 1 },
    engine_version: "b1",
    engine_version_checked: "b1",
    calibrated_at: "2026-10-29T00:00:00.000Z",
    duration_s: 10,
  };
  const trials: Array<{ step: string; data: Record<string, number | string | boolean | null> }> = [
    { step: "A/summary", data: { passed: true, n_ctx_train: 262144, template_thinking: true, chars_per_token: 3.26, decode_tps: 104.3, prefill_tps_2k: 1102, prefill_tps_8k: 1301, thinking_off: true, thinking_off_mode: true, thinking_on: true, json_off: true, json_on: true, array40: false } },
    {
      step: "B/summary",
      data: {
        window_tokens: 12352, hard_window_tokens: 32768, window_tokens_min: 10240, free_ram_bytes: 5e10,
        fill_fact: 4096, fill_aggregate: 0, fill_bug: 0, min_out_fact: 512, min_out_aggregate: 0, min_out_bug: 0,
        bug_thinking: "on", bug_json: true, thinking_off_mode: "leaky",
        grid: JSON.stringify([{ kind: "fact", counter: "main", tokens: 4096, trials: 5, passed: 5, inconclusive: 0, cuts: 0, cut_fails: 0, cut_cap: null }, { kind: "bug", tokens: 4096, skipped: "window", W: 12352 }]),
        unfit_reasons: JSON.stringify({ bug: "window 12352 too small for thinking on output" }),
      },
    },
    { step: "C/summary", data: { main_slots: 2, main_slot_ctx: 13056, aggregate_tps: 180.5, load_avg: 3.2, scout_candidates: "[]" } },
  ];
  it("is schema-valid; thinking_works.off comes from Phase B, window_tokens from the smallest W, no scouting candidate kept", () => {
    const r = okRecordFrom(base, trials);
    expect(recordSchemaErrors(r)).toEqual([]);
    expect(r).toMatchObject({ status: "ok", schema: 2, window_tokens: 10240, thinking_works: { off: "leaky", on: true }, main: { slots: 2, slot_ctx: 13056 }, scouting_candidates: [] });
    expect(r.unfit_reasons).toEqual({ bug: "window 12352 too small for thinking on output" });
    expect(r.speed).toEqual({ prefill_tps: 1102, decode_tps: 104.3, aggregate_tps: 180.5, load_avg: 3.2 });
  });
  it("every scored scouting candidate goes into the record, the threshold is not applied there; a missing summary throws", () => {
    const low = { share_tokens: 4096, slots: 4, slot_ctx: scoutSlotCtx(4096), accuracy: 0.6, records_per_s: 20, permutation_seed: 13100 };
    const high = { share_tokens: 2048, slots: 4, slot_ctx: scoutSlotCtx(2048), accuracy: 0.97, records_per_s: 12.5, permutation_seed: 11052 };
    const r = okRecordFrom(base, [...trials.slice(0, 2), { step: "C/summary", data: { ...trials[2]!.data, scout_candidates: JSON.stringify([high, low]) } }]);
    expect(recordSchemaErrors(r)).toEqual([]);
    expect(r.scouting_candidates).toEqual([high, low]);
    expect(scoutingFor(r.scouting_candidates!, 0.95)).toEqual(high);
    expect(scoutingFor(r.scouting_candidates!, 0.5)).toEqual(low);
    expect(recordSchemaErrors({ ...r, scouting_candidates: [{ ...high, accuracy: -1 }] })).not.toEqual([]);
    expect(recordSchemaErrors({ ...r, scouting_candidates: "unfit" })).not.toEqual([]);
    expect(() => okRecordFrom(base, trials.slice(0, 2))).toThrow(/no C\/summary/);
  });
  it("the scouting unfit reason (coordinator decision 2026-10-29): kept in the record only with no scored candidate, and printed by calibration-status", async () => {
    expect(scoutUnfitReason(["memory", "memory"])).toBe("over total RAM");
    expect(scoutUnfitReason(["timeout"])).toBe("timed out on 3 passes");
    expect(scoutUnfitReason(["memory", "timeout"])).toBe("over total RAM or timed out on 3 passes");
    const r = okRecordFrom(base, [...trials.slice(0, 2), { step: "C/summary", data: { ...trials[2]!.data, scouting_unfit_reason: "over total RAM" } }]);
    expect(recordSchemaErrors(r)).toEqual([]);
    expect(r).toMatchObject({ scouting_candidates: [], scouting_unfit_reason: "over total RAM" });
    // With scored candidates unfit is the threshold's call at read time: a reason there is refused.
    const one = { share_tokens: 2048, slots: 4, slot_ctx: scoutSlotCtx(2048), accuracy: 0.5, records_per_s: 1, permutation_seed: 1 };
    expect(recordSchemaErrors({ ...r, scouting_candidates: [one] })).toContain("scouting_unfit_reason");
    expect(recordSchemaErrors({ ...r, scouting_unfit_reason: "" })).toContain("scouting_unfit_reason");
    const dir = mkdtempSync(join(osTmpdir(), "llm-ext-phase-c-status-"));
    try {
      const profiles = { p: { server: "managed", api: "llamacpp-local", model: "m" } } as unknown as Record<string, Profile>;
      writeRecord(dir, { ...recordFixture("llama", "m"), scouting_candidates: [], scouting_unfit_reason: "timed out on 3 passes" });
      expect(await calibrationStatusText(dir, profiles)).toContain("scouting unfit: timed out on 3 passes (no candidate scored; the model is usable for everything else)");
      writeRecord(dir, { ...recordFixture("llama", "m"), scouting_candidates: [one] });
      expect(await calibrationStatusText(dir, profiles)).toMatch(/scouting unfit at threshold [\d.]+: no candidate reached the accuracy \(1 measured\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


/**
 * phaseC.run itself (review of a3862052, MINOR-3): the real phase code, the real memory reading (memory_pressure on
 * macOS) and a real GGUF header, against a real HTTP server on 127.0.0.1 that answers like llama-server. The tiny CI
 * GGUFs cannot serve Phase C (their trained context is 128 tokens, below any slot), so the server is this loopback
 * one; the context gives no process control (stop and restart keep the same server), which Phase C only uses to free
 * memory and change the slot shape.
 */
describe("phaseC.run: memory waits pause, never fail; a scouting timeout reruns the run", () => {
  let server: Server | null = null;
  let dir = "";
  const floorEnv = process.env.LLM_EXT_BROKER_MEMORY_FLOOR;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
    }
    server = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
    if (floorEnv === undefined) delete process.env.LLM_EXT_BROKER_MEMORY_FLOOR;
    else process.env.LLM_EXT_BROKER_MEMORY_FLOOR = floorEnv;
  });

  const fill = { fact: 2048, aggregate: 2048, bug: 2048 };
  const minOut = { fact: 256, aggregate: 256, bug: 256 };
  const recordCount = (body: Record<string, unknown>): number => {
    const msgs = body.messages as Array<{ content: string }>;
    return (msgs[msgs.length - 1]!.content.match(/name: skill-\d{6}/g) ?? []).length;
  };

  /**
   * A loopback server: throughput requests get 256 tokens at once. The first `bad` classify requests fail the way
   * `mode` says: "hang" never answers (the client times out), "reset" destroys the socket, a number is that HTTP status.
   */
  const serve = async (bad: number, mode: "hang" | "reset" | number = "hang"): Promise<{ url: string; classify: () => number }> => {
    let classify = 0;
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (d: Buffer) => (raw += d.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        const system = (body.messages as Array<{ content: string }>)[0]!.content;
        if (system.includes("frontmatter classifier")) {
          classify++;
          if (classify <= bad) {
            if (mode === "hang") return;
            if (mode === "reset") return void req.socket.destroy();
            res.writeHead(mode, { "content-type": "text/plain" });
            return void res.end("busy");
          }
          const content = JSON.stringify({ categories: Array.from({ length: recordCount(body) }, () => "debugging") });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 40 } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "words ".repeat(256) }, finish_reason: "length" }], usage: { prompt_tokens: 2048, completion_tokens: 256 } }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, classify: () => classify };
  };

  /** The synthetic GGUF: `blocks` scales the KV cache, 128 bytes per token per block (1 KV head of 32 dims, 2 bytes, K and V). */
  const writeModel = (gguf: string, blocks: number): void =>
    writeGguf(gguf, [
      ["general.architecture", "lfm3"],
      ["lfm3.block_count", blocks],
      ["lfm3.attention.head_count", 2],
      ["lfm3.embedding_length", 64],
      ["lfm3.attention.head_count_kv", 1],
    ]);
  /** A Phase C context over a synthetic GGUF, with Phase A and B summaries already recorded. `stops` lists every stopServer reason. */
  const context = (url: string, harness: { mainSlots: number[]; scoutShares: number[]; scoutSlots: number[] }, memoryWait: Record<string, MemoryWait> = {}, blocks = 2) => {
    dir = mkdtempSync(join(osTmpdir(), "llm-ext-phase-c-run-"));
    const gguf = join(dir, "m.gguf");
    writeModel(gguf, blocks);
    const trials: TrialRecord[] = [
      { step: "A/summary", seed: 0, outcome: "pass", at: "t", data: { chars_per_token: 4, prefill_tps_2k: 100000, prefill_tps_8k: 100000, decode_tps: 100000, array40: true } },
      { step: "B/summary", seed: 0, outcome: "pass", at: "t", data: { fill_fact: fill.fact, fill_aggregate: fill.aggregate, fill_bug: fill.bug, min_out_fact: 256, min_out_aggregate: 256, min_out_bug: 256, bug_thinking: "off" } },
    ];
    const logs: string[] = [];
    const stops: string[] = [];
    const ctx = {
      item: { engine: "llama", model: "m", reason: "manual" },
      identity: { files: [gguf] },
      harness,
      server: { engine: "llama", model: "m", baseUrl: url, apiKey: "k" },
      progress: { trials, phases: { A: "passed", B: "passed" }, paused: {}, stepCrashes: {}, memoryWait },
      record: (t: TrialRecord) => trials.push(t),
      save: () => undefined,
      log: (m: string) => logs.push(m),
      waitForTurn: async () => undefined,
      stopServer: async (why: string) => void stops.push(why),
      restart: async () => undefined,
    } as unknown as PhaseContext;
    return { ctx, trials, logs, gguf, stops };
  };
  /** A wait that has already counted MEMORY_WAIT_MAX_MS of checks: the next check skips the candidate for the pass. */
  const expiredWait = (): MemoryWait => ({ ...memoryWaitTick(undefined, 1, Date.now() - MEMORY_WAIT_MAX_MS), waited_ms: MEMORY_WAIT_MAX_MS, seen: new Date().toISOString() });

  /** A memory floor that leaves room for n slots in total RAM but not in the free memory now (wait, not skip). */
  const waitFloorPct = (gguf: string, slots: number): number => {
    const need = weightBytes([gguf]) + kvBytes(modelKvLayers("llama", [gguf]), slots * mainSlotCtx(fill, minOut, "off")) + WINDOW_HEADROOM_BYTES;
    return Math.floor((100 * (totalmem() - need - 1024 ** 3)) / totalmem());
  };

  it("a candidate short of free memory waits (paused, the start saved); after 30 min every one is skipped for now: paused, not failed", async () => {
    const { url } = await serve(0);
    const { ctx, trials } = context(url, { mainSlots: [1, 2], scoutShares: [2048], scoutSlots: [4] });
    process.env.LLM_EXT_BROKER_MEMORY_FLOOR = String(waitFloorPct(ctx.identity.files[0]!, 2));
    const first = await phaseC.run(ctx);
    expect(first).toMatchObject({ passed: false, paused: true, step: "C/main/1" });
    expect(Object.keys(ctx.progress.memoryWait ?? {})).toEqual(["C/main/1"]);

    // Both waits started 31 minutes ago: each main candidate is skipped for this pass (pass 1 of 3, rule A), and the
    // scouting candidate, short of memory too, now waits: the pass pauses, no record is written.
    ctx.progress.memoryWait = { "C/main/1": expiredWait(), "C/main/2": expiredWait() };
    const second = await phaseC.run(ctx);
    expect(second).toMatchObject({ passed: false, paused: true, step: "C/scout/2048/4" });
    expect((second as { message: string }).message).toMatch(/the model waits for memory/);
    const skips = trials.filter((t) => t.step.startsWith("C/main/"));
    expect(skips.map((t) => [t.step, t.outcome, t.data?.skipped, t.data?.passes])).toEqual([
      ["C/main/1", "inconclusive", "memory-wait", 1],
      ["C/main/2", "inconclusive", "memory-wait", 1],
    ]);
    expect(Object.keys(ctx.progress.memoryWait ?? {})).toEqual(["C/scout/2048/4"]);
    expect(trials.some((t) => t.step === "C/summary")).toBe(false);

    // A resume with memory back measures both again (the skips were not terminal) and Phase C passes.
    delete process.env.LLM_EXT_BROKER_MEMORY_FLOOR;
    const third = await phaseC.run(ctx);
    expect(third).toEqual({ passed: true });
    expect(trials.filter((t) => t.step.startsWith("C/main/") && typeof t.data?.aggregate_tps === "number").map((t) => t.step)).toEqual(["C/main/1", "C/main/2"]);
  }, 120_000);

  it("every main candidate over total RAM: too big for this machine's memory (rule 1), judged against total RAM, the floor and the trained context; the old wait entry is cleared", async () => {
    const { url } = await serve(0);
    const { ctx, trials } = context(url, { mainSlots: [1, 2], scoutShares: [2048], scoutSlots: [4] }, { "C/main/1": memoryWaitTick(undefined, 1, Date.now()) });
    trials.push({ step: "A/capabilities", seed: 0, outcome: "pass", at: "t", data: { n_ctx_train: 4096 } });
    process.env.LLM_EXT_BROKER_MEMORY_FLOOR = "99";
    const r = await phaseC.run(ctx);
    expect(r).toMatchObject({ passed: false, step: "C/main", memory: { kind: "too-big", judged: { total_ram_bytes: totalmem(), floor_pct: 99, n_ctx_train: 4096 } } });
    expect((r as { message: string }).message).toMatch(/^the model is too big for this machine's memory: no main-slot candidate fits/);
    expect(r).not.toHaveProperty("paused");
    expect(ctx.progress.memoryWait).toEqual({});
  }, 60_000);


  it("every scouting candidate over total RAM: scouting is unfit 'over total RAM', the main slots stand, Phase C passes", async () => {
    const { url } = await serve(0);
    // 2048 blocks: 256 KiB of KV per token, so 1 main slot (about 1.2 GiB of KV) fits and 256 scouting slots cannot.
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [256] }, {}, 2048);
    const files = ctx.identity.files;
    const need = (slots: number, slotCtx: number): number => weightBytes(files) + kvBytes(modelKvLayers("llama", files), slots * slotCtx) + WINDOW_HEADROOM_BYTES;
    expect(need(256, scoutSlotCtx(2048))).toBeGreaterThan(totalmem());
    const r = await phaseC.run(ctx);
    expect(r).toEqual({ passed: true });
    expect(typeof trials.find((t) => t.step === "C/main/1")?.data?.aggregate_tps).toBe("number");
    expect(trials.find((t) => t.step === "C/scout/2048/256")).toMatchObject({ outcome: "pass", data: { skipped: "memory" } });
    const summary = trials.find((t) => t.step === "C/summary")!;
    expect(summary.data).toMatchObject({ main_slots: 1, scout_candidates: "[]", scouting_unfit_reason: "over total RAM" });
  }, 60_000);

  it("rule A: a scouting candidate inconclusive on its 3rd runner pass (here a timeout) is given up: scouting unfit 'timed out on 3 passes'", async () => {
    const { url } = await serve(Number.MAX_SAFE_INTEGER);
    const { ctx, trials, logs } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    const step = "C/scout/2048/4";
    const data = { share: 2048, slots: 4, slot_ctx: scoutSlotCtx(2048) };
    // Two earlier passes left it inconclusive, one on a timeout and one on a memory wait: both count as passes.
    trials.push(
      { step, seed: 9052, outcome: "inconclusive", at: "t", data: { ...data, skipped: "timeout", passes: 1 } },
      { step, seed: 4, outcome: "inconclusive", at: "t", data: { ...data, skipped: "memory-wait", waited_min: 30, passes: 2 } },
    );
    const r = await phaseC.run(ctx);
    expect(r).toEqual({ passed: true });
    expect(INCONCLUSIVE_PASSES).toBe(3);
    expect(trials.filter((t) => t.step === step).at(-1)).toMatchObject({ outcome: "pass", data: { skipped: "timeout", passes: 3 } });
    expect(logs).toContain(`${step}: a scouting run timed out after its reruns, pass 3 of 3: given up, not scored`);
    const summary = trials.find((t) => t.step === "C/summary")!;
    expect(summary.data).toMatchObject({ scout_candidates: "[]", scouting_unfit_reason: "timed out on 3 passes" });
  }, 480_000);

  /**
   * Rule A tests: a 1 % memory floor and a slot count that fits total RAM minus the floor but not the free memory now
   * (so the candidate waits), while one main slot and one scouting slot run. Review m8 (coordinator decision 5: no
   * precondition may depend on how much memory is in use): the synthetic KV per token (`blocks`) is sized from this
   * machine's own reading, as in phase-b.test.ts, so that n slots need the midpoint between free memory and total RAM
   * (both above the floor and the headroom) and one slot of the largest context needs at most half the free memory.
   * Each margin is then at least a quarter of the memory in use, never a fixed 2 GiB a busy machine lacks. The one
   * reading-dependent precondition: the 1 GiB headroom fits free memory above the floor (nothing can run otherwise).
   */
  const waitSlots = async (slotCtx: number): Promise<{ blocks: number; n: number }> => {
    process.env.LLM_EXT_BROKER_MEMORY_FLOOR = "1";
    const total = totalmem();
    const { free, floor } = await freeMemory(1);
    const probe = mkdtempSync(join(osTmpdir(), "llm-ext-phase-c-probe-"));
    let head: number;
    let perToken: number;
    try {
      const gguf = join(probe, "m.gguf");
      writeModel(gguf, 1);
      head = weightBytes([gguf]) + WINDOW_HEADROOM_BYTES;
      perToken = kvBytes(modelKvLayers("llama", [gguf]), 1);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
    const runCtx = Math.max(mainSlotCtx(fill, minOut, "off"), scoutSlotCtx(2048));
    // KV bytes available: F above the floor in free memory now, T in total RAM.
    const F = free - floor - head;
    const T = total - floor - head;
    expect(F, `free memory above the 1 % floor (${Math.round((free - floor) / 2 ** 20)} MiB) must hold the 1 GiB headroom`).toBeGreaterThan(0);
    const blocks = Math.max(1, Math.floor(Math.min((T - F) / 2 / (perToken * slotCtx), F / 2 / (perToken * runCtx))));
    const slot = blocks * perToken * slotCtx;
    const n = Math.round((F + T) / 2 / slot);
    const inUse = `memory in use ${Math.round((total - free) / 2 ** 20)} MiB`;
    expect(F - blocks * perToken * runCtx, `one slot of ${runCtx} tokens must fit free memory (${inUse})`).toBeGreaterThan(0);
    expect(n * slot - F, `${n} slots must miss free memory (${inUse})`).toBeGreaterThan(0);
    expect(T - n * slot, `${n} slots must fit total RAM minus the floor (${inUse})`).toBeGreaterThan(0);
    return { blocks, n };
  };
  const statusProfiles = { p: { server: "managed", api: "llamacpp-local", model: "m" } } as unknown as Record<string, Profile>;
  const statusOf = async (ctx: PhaseContext): Promise<string> => {
    saveProgress(dir, "llama", "m", { ...ctx.progress, harness_version: HARNESS_VERSION, fixture_version: FIXTURE_VERSION, harness: null, fingerprint: null });
    return calibrationStatusText(dir, statusProfiles);
  };

  it("rule A: an unscored scouting candidate pauses Phase C on passes 1 and 2 (status: cause and pass k of 3), a memory pause is not a pass, pass 3 makes scouting unfit", async () => {
    const { url } = await serve(0);
    const { blocks, n } = await waitSlots(scoutSlotCtx(2048));
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [1] }, {}, blocks);
    ctx.harness.scoutSlots = [n];
    const step = `C/scout/2048/${n}`;
    const statuses: string[] = [];
    const messages: string[] = [];
    for (let pass = 1; pass <= 2; pass++) {
      // A pass that only waits for memory records nothing, so it is not counted.
      expect(await phaseC.run(ctx)).toMatchObject({ passed: false, paused: true, step });
      ctx.progress.memoryWait = { [step]: expiredWait() };
      const r = await phaseC.run(ctx);
      expect(r).toMatchObject({ passed: false, paused: true, step });
      expect(trials.some((t) => t.step === "C/summary")).toBe(false);
      messages.push((r as { message: string }).message);
      statuses.push(await statusOf(ctx));
    }
    expect(await phaseC.run(ctx)).toMatchObject({ passed: false, paused: true, step });
    ctx.progress.memoryWait = { [step]: expiredWait() };
    // The behaviour first (2411e6dc paused here for ever), then the counts and the words.
    expect(await phaseC.run(ctx)).toEqual({ passed: true });
    expect(trials.filter((t) => t.step === step).map((t) => [t.outcome, t.data?.skipped, t.data?.passes])).toEqual([
      ["inconclusive", "memory-wait", 1],
      ["inconclusive", "memory-wait", 2],
      ["pass", "memory-wait", 3],
    ]);
    expect(trials.find((t) => t.step === "C/summary")?.data).toMatchObject({ main_slots: 1, scout_candidates: "[]", scouting_unfit_reason: "waited for free memory on 3 passes" });
    for (const m of messages) expect(m).toMatch(/not measured yet .*Phase C writes no record until then/);
    statuses.forEach((s, i) => expect(s).toContain(`${step} pending: still short of free memory after 30 min, pass ${i + 1} of 3; measured again on the next pass`));
    expect(await statusOf(ctx)).not.toContain(`${step} pending`);
  }, 180_000);

  it("rule A: a pending main candidate holds the record although another one is scored; given up on pass 3, the slot count comes from the scored ones", async () => {
    const { url } = await serve(0);
    const { blocks, n } = await waitSlots(mainSlotCtx(fill, minOut, "off"));
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [1] }, {}, blocks);
    ctx.harness.mainSlots = [1, n];
    const step = `C/main/${n}`;
    for (let pass = 1; pass <= 3; pass++) {
      expect(await phaseC.run(ctx)).toMatchObject({ passed: false, paused: true, step });
      ctx.progress.memoryWait = { [step]: expiredWait() };
      const r = await phaseC.run(ctx);
      if (pass < 3) {
        expect(r).toMatchObject({ passed: false, paused: true, step });
        expect(trials.some((t) => t.step === "C/summary")).toBe(false);
        expect(await statusOf(ctx)).toContain(`${step} pending: still short of free memory after 30 min, pass ${pass} of 3`);
      } else expect(r).toEqual({ passed: true });
    }
    expect(trials.filter((t) => t.step === step).map((t) => [t.outcome, t.data?.passes])).toEqual([["inconclusive", 1], ["inconclusive", 2], ["pass", 3]]);
    expect(trials.find((t) => t.step === "C/summary")?.data).toMatchObject({ main_slots: 1 });
  }, 180_000);

  it("rule 2: every main candidate given up after its memory waits is memory-limited (no verdict), never a failure", async () => {
    const { url } = await serve(0);
    const { blocks, n } = await waitSlots(mainSlotCtx(fill, minOut, "off"));
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [1] }, {}, blocks);
    ctx.harness.mainSlots = [n];
    const step = `C/main/${n}`;
    for (let pass = 1; pass <= 3; pass++) {
      expect(await phaseC.run(ctx)).toMatchObject({ passed: false, paused: true, step });
      ctx.progress.memoryWait = { [step]: expiredWait() };
      const r = await phaseC.run(ctx);
      if (pass < 3) expect(r).toMatchObject({ passed: false, paused: true, step });
      else expect(r).toEqual({ passed: false, step: "C/main", message: `no main-slot candidate could be measured for lack of free memory: ${step} waited for free memory on 3 passes`, memory: { kind: "memory-limited" } });
    }
    expect(trials.some((t) => t.step === "C/summary")).toBe(false);
  }, 180_000);

  it("an over-total-RAM skip stands only under the floor it was judged against: a changed floor measures it again (review of 2411e6dc, finding 11)", async () => {
    const { url } = await serve(0);
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [4, 8] });
    delete process.env.LLM_EXT_BROKER_MEMORY_FLOOR;
    const floorNow = timingsFromEnv(process.env).memoryFloorPct;
    const skip = (n: number, floorPct: number): TrialRecord => ({ step: `C/scout/2048/${n}`, seed: n, outcome: "pass", at: "t", data: { share: 2048, slots: n, slot_ctx: scoutSlotCtx(2048), skipped: "memory", floor_pct: floorPct } });
    trials.push(skip(4, floorNow === 99 ? 98 : 99), skip(8, floorNow));
    expect(await phaseC.run(ctx)).toEqual({ passed: true });
    // Judged under another floor: measured again and scored. Judged under this floor: the skip stands.
    expect(typeof trials.filter((t) => t.step === "C/scout/2048/4").at(-1)?.data?.accuracy).toBe("number");
    expect(trials.filter((t) => t.step === "C/scout/2048/8")).toHaveLength(1);
    expect(JSON.parse(String(trials.find((t) => t.step === "C/summary")?.data?.scout_candidates))).toHaveLength(1);
  }, 120_000);
  it("a scouting run whose requests time out is repeated on the same copies and then scored; the timed-out attempt is not", async () => {
    const { url, classify } = await serve(4);
    const { ctx, trials, logs } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    const r = await phaseC.run(ctx);
    expect(r).toEqual({ passed: true });
    expect(logs.some((l) => /run 1: 4 of 4 request\(s\) timed out and 0 lost the connection; the run is repeated \(1 of 2\)/.test(l))).toBe(true);
    // 4 hung + 4 rerun + 2 more runs of 4.
    expect(classify()).toBe(16);
    const scout = trials.find((t) => t.step === "C/scout/2048/4")!;
    expect(scout.outcome).toBe("pass");
    // The same seeds Phase C uses: permutation seed 9000 + share + n, plus run * n + i for each copy.
    let records = 0;
    for (let run = 0; run < 3; run++) for (let i = 0; i < 4; i++) records += calibrationScoutFixture(9000 + 2048 + 4 + run * 4 + i, 2048 * 4).recordCount;
    expect(scout.data).toMatchObject({ errors: 0, records });
    // The wall time counts only the answered attempts, not the 120 s timeout.
    expect(Number(scout.data?.records_per_s)).toBeGreaterThan(Number(scout.data?.records) / 60);
    const summary = trials.find((t) => t.step === "C/summary")!;
    expect(JSON.parse(String(summary.data?.scout_candidates))).toHaveLength(1);
  }, 300_000);

  /**
   * Review of a3862052, MINOR-4: Phase C reads classifyPositional's own error texts, so these drive the real producer
   * against the loopback server; a reworded producer text fails here. MINOR-6: a lost connection (a reset socket,
   * HTTP 502/503/504) is load, like a timeout; HTTP 400 and 500 are the model's own errors and stay scored.
   */
  it.each([
    ["hang", true, false],
    ["reset", false, true],
    [502, false, true],
    [503, false, true],
    [504, false, true],
    [500, false, false],
    [400, false, false],
  ] as const)("classifyPositional's own error for a %s request reads as timeout %s, lost connection %s", async (mode, timeout, lost) => {
    const { url } = await serve(1, mode);
    const fx = calibrationScoutFixture(1, 2048);
    const r = await classifyPositional("m", url, "k", fx, buildPositionalSchema(fx.recordCount), { timeoutMs: 500 });
    expect(r.error).not.toBeNull();
    expect([isScoutTimeout(r.error), isScoutTransportFailure(r.error)]).toEqual([timeout, lost]);
  });

  it("MINOR-6: a scouting run whose requests lose the connection is repeated after memory is checked again, then scored; the lost attempt is not", async () => {
    const { url, classify } = await serve(4, "reset");
    const { ctx, trials, logs, stops } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    expect(await phaseC.run(ctx)).toEqual({ passed: true });
    expect(logs.some((l) => /C\/scout\/2048\/4: run 1: 0 of 4 request\(s\) timed out and 4 lost the connection; the run is repeated \(1 of 2\)/.test(l))).toBe(true);
    // Memory is measured before the first run and again before the rerun.
    expect(stops.filter((s) => s === "measuring free memory for C/scout/2048/4")).toHaveLength(2);
    expect(classify()).toBe(16);
    expect(trials.find((t) => t.step === "C/scout/2048/4")).toMatchObject({ outcome: "pass", data: { errors: 0, accuracy: expect.any(Number) } });
  }, 120_000);

  it("MINOR-6: HTTP 503 on every rerun leaves the scouting candidate pending (lost connection, pass 1 of 3), never scored all-wrong", async () => {
    const { url, classify } = await serve(Number.MAX_SAFE_INTEGER, 503);
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    const r = await phaseC.run(ctx);
    expect(r).toMatchObject({ passed: false, paused: true, step: "C/scout/2048/4" });
    expect(classify()).toBe(12);
    expect(trials.filter((t) => t.step === "C/scout/2048/4").map((t) => [t.outcome, t.data?.skipped, t.data?.passes, t.data?.accuracy])).toEqual([["inconclusive", "transport", 1, undefined]]);
    expect(await statusOf(ctx)).toContain("C/scout/2048/4 pending: a scouting run lost its connection (reset, or HTTP 502/503/504) after its reruns, pass 1 of 3");
  }, 120_000);

  it("MINOR-6: an HTTP 400 is the model's own error: the run is not repeated and its records score as wrong", async () => {
    const { url, classify } = await serve(4, 400);
    const { ctx, trials } = context(url, { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    expect(await phaseC.run(ctx)).toEqual({ passed: true });
    expect(classify()).toBe(12);
    expect(trials.find((t) => t.step === "C/scout/2048/4")).toMatchObject({ outcome: "pass", data: { errors: 4 } });
  }, 120_000);

  it("finding 2 (review of 2411e6dc): a saved memory wait is re-checked with the model unloaded; the pass loads it only once memory is back or the wait is over", async () => {
    const { ctx } = context("http://127.0.0.1:1", { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    const save = (w: Record<string, MemoryWait>): void => saveProgress(dir, "llama", "m", { ...ctx.progress, memoryWait: w, harness_version: HARNESS_VERSION, fixture_version: FIXTURE_VERSION, harness: PRODUCTION_HARNESS_ID, fingerprint: null });
    const load = (): Record<string, MemoryWait> => loadProgress(dir, "llama", "m", null).memoryWait ?? {};
    expect(await memoryWaitPrecheck(dir, "llama", "m", PRODUCTION_HARNESS_ID)).toBeNull();
    // Needs more than the machine has free: the pass is skipped, and the check counts toward the wait.
    const before = memoryWaitTick(undefined, totalmem() * 2, Date.now() - 60_000);
    save({ "C/scout/2048/4": before });
    expect(await memoryWaitPrecheck(dir, "llama", "m", PRODUCTION_HARNESS_ID)).toMatch(/^C\/scout\/2048\/4 still waits for free memory \(\d+ MiB needed, -?\d+ MiB free above the floor; 1 of 30 min counted\)$/);
    expect(load()["C/scout/2048/4"]!.waited_ms).toBeGreaterThanOrEqual(60_000);
    // A wait already over: the model is loaded, and Phase C records the skip.
    save({ "C/scout/2048/4": { ...before, waited_ms: MEMORY_WAIT_MAX_MS } });
    expect(await memoryWaitPrecheck(dir, "llama", "m", PRODUCTION_HARNESS_ID)).toBeNull();
    // Memory back (1 byte needed): the model is loaded and measured.
    save({ "C/scout/2048/4": { ...before, need: 1 } });
    expect(await memoryWaitPrecheck(dir, "llama", "m", PRODUCTION_HARNESS_ID)).toBeNull();
  });

  it("MINOR-7 (review of a3862052): a model being calibrated again under an older record shows its memory wait and pending candidates", async () => {
    const { ctx } = context("http://127.0.0.1:1", { mainSlots: [1], scoutShares: [2048], scoutSlots: [4] });
    writeRecord(dir, recordFixture("llama", "m"));
    ctx.progress.memoryWait = { "C/main/1": memoryWaitTick(undefined, 1, Date.now()) };
    ctx.progress.trials.push({ step: "C/scout/2048/4", seed: 1, outcome: "inconclusive", at: "t", data: { skipped: "timeout", passes: 2 } });
    expect(await statusOf(ctx)).not.toContain("being calibrated again");
    enqueueUnlocked(dir, { engine: "llama", model: "m", reason: "manual", force: true });
    const text = await statusOf(ctx);
    expect(text).toMatch(/'m': calibrated .*; being calibrated again \(A passed, B passed, C pending\); C\/main\/1 waiting for free memory since \S+ \(0 of 30 min counted, then skipped for this pass\); C\/scout\/2048\/4 pending: a scouting run timed out after its reruns, pass 2 of 3/);
  });
});
