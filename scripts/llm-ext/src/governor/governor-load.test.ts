/**
 * governor/governor-load.test.ts — model loads and RAM under the local-inference
 * governor (design/specs/local-inference-governor-design.md D6, D8, D11, unit 4).
 *
 * The rules are pure tables. Everything else is real: the governor state file,
 * the machine's own RAM reading, a child process that really allocates memory,
 * and brokers serving the two tiny GGUF models of broker.test.ts through real
 * llama-servers. RAM pressure cannot be produced for real on a machine far below
 * the lowest allowed limit (50 percent), so the projection is the lever: a
 * record whose load_estimate does not fit the room left now. Assertions are
 * invariants read from recorded data (logs, the state file, sampled leases).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureBroker, type BrokerEndpoint } from "../broker/client.js";
import { COMMAND_HEADER, CTX_HEADER, ENGINE_HEADER, isBrokerProcess, QUEUE_TIMEOUT_HEADER, readBrokerState, TIMEOUT_HEADER, TOKEN_HEADER } from "../broker/protocol.js";
import { readRegistry } from "../broker/registry.js";
import { loadedIdentity, type LoadedIdentity } from "../calibration/fingerprint.js";
import { HARNESS_VERSION, okRecordFrom, readRecord, readRecordStatus, recordPath, recordSchemaErrors, writeRecord, type CalibrationRecord, type RecordBase } from "../calibration/record.js";
import { writeGguf } from "../calibration/test-gguf.js";
import { startCalServer, type CalServer } from "../calibration/runner.js";
import { recordFixture } from "../calibration/test-record.js";
import { isLocalsServerArgv, processSnapshot, SPAWN_MARKER } from "../local-llama-server.js";
import { tmpdir } from "../test-tmp-root.js";
import * as gov from "./client.js";
import { bookedBytes, decide, loadFits, neededBytes, neverFits, pickUnload, type GrantRequest } from "./controller.js";
import { meminfoUsedBytes, vmStatUsedBytes } from "./ram.js";
import { estimateFromFiles, loadBounds, weightFilesOnDisk } from "./estimate.js";
import { afterBreach, BREACHES_TO_FAIL, learnedLowerBound, LOAD_LEASE_MS, loadFigures, localsCacheGb, neverFitsMessage, readyBooking, reloadAfterUnloadMs, swapHeld, watchLoad } from "./load.js";
import { WINDOW_HEADROOM_BYTES } from "../calibration/memory.js";
import { readMemory } from "./metrics.js";
import { emptyState, readState, reap, withStateLock, type GovernorLimits, type Lease, type ServerEntry, type Waiter } from "./state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GIB = 1024 ** 3;
const TOTAL = 64 * GIB;
const NOW = 1_000_000;
const LIMITS: GovernorLimits = { ramLimitPct: 90, cpuLimitPct: 100, maxInferences: 8 };
const CONFIG = { cores: 8, totalBytes: TOTAL, settleMs: 2_000, loadYieldMs: 120_000 };
const LLAMA_CACHE = "/tmp/llm-ext-llama-cache";
const A = "ggml-org/tiny-llamas/stories15M-q4_0.gguf";
const B = "ggml-org/tiny-llamas/stories260K.gguf";
const DEADLINE_MS = 180_000;
const TEST_MS = 300_000;

function waiter(id: string, over: Partial<Waiter> = {}): Waiter {
  return { id, kind: "load", weight: 1, holder: { pid: 1, start: "" }, since: NOW, polledAt: NOW, queueTimeoutMs: null, limits: LIMITS, ...over };
}

function loadRequest(over: Partial<GrantRequest> = {}): GrantRequest {
  return { ...waiter("r"), threads: 0, serverPid: null, ...over };
}

function lease(over: Partial<Lease> = {}): Lease {
  return { id: "l", kind: "inference", weight: 1, threads: 0, serverPid: null, bytes: 0, holder: { pid: 1, start: "" }, at: NOW, expiresAt: NOW + 1000, ...over };
}

function server(pid: number, over: Partial<ServerEntry> = {}): ServerEntry {
  return { pid, start: "", ownerPid: 7, ownerStart: "", threads: 0, bookedBytes: 0, residentBytes: 0, lastUsedAt: NOW, wantUnload: false, engine: "llama", role: "main", ...over };
}

/** A view at `usedPct` RAM used, CPU cool, a fresh reading, with `request` the head of the load queue. */
function view(usedPct: number, leases: Lease[] = [], waiters: Waiter[] = [waiter("r")]) {
  return { ...emptyState(), metrics: { at: NOW, cpuSample: null, cpuPct: 10, freePct: 100 - usedPct }, waiters, leases };
}

describe("load projection and admission (pure)", () => {
  it.each([
    { name: "fits with room to spare", used: 20, bytes: 10 * GIB, out: 0, fits: true },
    { name: "exactly at the limit fits", used: 50, bytes: 0.4 * TOTAL, out: 0, fits: true },
    { name: "one byte over does not", used: 50, bytes: 0.4 * TOTAL + 1, out: 0, fits: false },
    { name: "the outgoing server's RAM counts as given back", used: 80, bytes: 20 * GIB, out: 15 * GIB, fits: true },
    { name: "without it the same load does not fit", used: 80, bytes: 20 * GIB, out: 0, fits: false },
    { name: "an unknown projection (0) fits by construction: it runs alone, under the watchdog", used: 89, bytes: 0, out: 0, fits: true },
  ])("loadFits: $name", ({ used, bytes, out, fits }) => {
    expect(loadFits(used, bytes, out, LIMITS, TOTAL, 0)).toBe(fits);
  });

  it("loadFits counts a registered server by its booking: a Locals server's projection, never a llama one's (the reading has llama's wired pages; round 3, round 4 #2)", () => {
    // 50 % of 64 GiB used, the limit 90 %: 25.6 GiB of room.
    const run = (engine: "llama" | "locals") => {
      const f = loadFigures(engine, { bytes: 20 * GIB, minBytes: 5 * GIB, weightBytes: 4 * GIB, alone: false }, LIMITS, TOTAL);
      return decide({ ...view(50), servers: [server(5, { engine, bookedBytes: f.bookedBytes, residentBytes: f.residentBytes })] }, loadRequest({ bytes: 10 * GIB }), NOW, CONFIG);
    };
    expect(run("llama")).toMatchObject({ grant: true });
    expect(run("locals")).toMatchObject({ grant: false, denial: "ram" });
    expect(bookedBytes([server(1, { engine: "locals", bookedBytes: 3 }), server(2, { engine: "llama", residentBytes: 100 }), server(3, { engine: "locals", bookedBytes: 4, role: "cal" })])).toBe(7);
  });

  it("loadFigures: a server's booking and what stopping it gives back for sure never exceed what it really holds (round 4 #2, #3)", () => {
    const plan = { bytes: 20 * GIB, minBytes: 5 * GIB, weightBytes: 4 * GIB, alone: false };
    // Locals: booked by its projection; stopping it gives back exactly that.
    expect(loadFigures("locals", plan, LIMITS, TOTAL)).toEqual({ unbounded: false, bookedBytes: 20 * GIB, residentBytes: 20 * GIB, cacheRestBytes: 16 * GIB });
    // llama: booked by nothing (the reading has it); stopping it gives back its weights, never its projection: the KV and
    // headroom of the upper bound are not wired until used (measured wired rise: weights + 0.2 to 0.4 GiB).
    expect(loadFigures("llama", plan, LIMITS, TOTAL)).toMatchObject({ bookedBytes: 0, residentBytes: 4 * GIB });
    expect(loadFigures("llama", { ...plan, weightBytes: 0 }, LIMITS, TOTAL).residentBytes).toBe(0);
    // An alone load (marked after a breach), an unknown upper bound, or one that could never fit: sized by its lower bound,
    // the prompt cache's room included (round 4 #3); never the upper bound minus the cache.
    for (const p of [{ ...plan, alone: true }, { ...plan, bytes: 0 }, { ...plan, bytes: 100 * GIB }]) {
      // Round 5 M2(a): the lower bound carries the smallest prompt cache, so the rest leaves it out: an alone grant judged
      // on the lower bound leaves room for that cache.
      expect(loadFigures("locals", p, LIMITS, TOTAL)).toEqual({ unbounded: true, bookedBytes: 5 * GIB, residentBytes: 5 * GIB, cacheRestBytes: 5 * GIB - 0.1 * GIB });
    }
  });

  it("vm_stat: anonymous + wired + compressor pages times the page size, from a real vm_stat output; a missing field is an error (round 3)", () => {
    const text = readFileSync(join(HERE, "fixtures", "vm_stat-darwin.txt"), "utf8");
    expect(vmStatUsedBytes(text)).toBe((1_520_520 + 1_622_586 + 459_261) * 16_384);
    expect(() => vmStatUsedBytes(text.replace(/^Pages wired down:.*$/m, ""))).toThrow(/no 'Pages wired down' line/);
    expect(() => vmStatUsedBytes(text.replace("page size of 16384 bytes", ""))).toThrow(/no page size/);
    // File-backed pages are the GGUF page cache: reclaimable, never counted.
    expect(vmStatUsedBytes(text.replace(/^File-backed pages:\s+\d+\./m, "File-backed pages:    99999999."))).toBe(vmStatUsedBytes(text));
    expect(meminfoUsedBytes("MemTotal:       16000 kB\nMemFree:  1 kB\nMemAvailable:    6000 kB\n")).toBe(10_000 * 1024);
    expect(() => meminfoUsedBytes("MemTotal:       16000 kB\n")).toThrow(/no MemAvailable line/);
  });
  it("neverFits: above ram_limit_pct of all RAM, whatever is used now", () => {
    expect(neverFits(0.9 * TOTAL, LIMITS, TOTAL)).toBe(false);
    expect(neverFits(0.9 * TOTAL + 1, LIMITS, TOTAL)).toBe(true);
    expect(neverFitsMessage("m", 100 * GIB, LIMITS, TOTAL)).toMatch(/model 'm' needs about 102400 MiB .* 58982 MiB that ram_limit_pct 90% allows of this machine's 65536 MiB/);
  });

  it.each([
    { name: "a load that fits is granted", bytes: 10 * GIB, leases: [], grant: true, denial: null },
    { name: "a load whose projection does not fit waits on RAM", bytes: 40 * GIB, leases: [], grant: false, denial: "ram" },
    { name: "another load running: one at a time, whatever the projection", bytes: 1, leases: [lease({ kind: "load" })], grant: false, denial: "load" },
    { name: "an unknown projection is granted alone", bytes: 0, leases: [], grant: true, denial: null },
    { name: "an unknown projection waits while an inference runs (round 2 #4)", bytes: 0, leases: [lease()], grant: false, denial: "alone" },
  ])("decide: $name (50% used, limit 90%)", ({ bytes, leases, grant, denial }) => {
    const d = decide(view(50, leases), loadRequest({ bytes }), NOW, CONFIG);
    expect({ grant: d.grant, denial: d.denial }).toEqual({ grant, denial });
  });

  // Round 2 #1: the upper bound (70 GiB) is over what 90 % of 64 GiB allows; the lower bound (20 GiB) is not.
  it.each([
    { name: "alone, with room for the lower bound: granted", used: 10, leases: [], servers: [], grant: true, denial: null },
    { name: "an inference running: it waits", used: 10, leases: [lease()], servers: [], grant: false, denial: "alone" },
    { name: "another owner's server loaded: it waits", used: 10, leases: [], servers: [server(5, { ownerPid: 7 })], grant: false, denial: "alone" },
    { name: "only its own server loaded (the outgoing one): granted", used: 10, leases: [], servers: [server(5, { ownerPid: 1 })], grant: true, denial: null },
    { name: "alone but the lower bound does not fit the reading: it waits on RAM", used: 70, leases: [], servers: [], grant: false, denial: "ram" },
  ])("decide, upper bound over the limit, lower under it: $name", ({ used, leases, servers, grant, denial }) => {
    const d = decide({ ...view(used, leases), servers }, loadRequest({ bytes: 70 * GIB, minBytes: 20 * GIB }), NOW, CONFIG);
    expect({ grant: d.grant, denial: d.denial }).toEqual({ grant, denial });
  });

  it("a load head its own projection denies yields to a load waiter behind it, as any limit of its own (D13)", () => {
    const d = decide(view(50, [], [waiter("r"), waiter("small")]), loadRequest({ bytes: 40 * GIB }), NOW, CONFIG);
    expect(d).toMatchObject({ grant: false, denial: "ram", yields: true });
  });

  it("but only for loadYieldMs: after that it holds the head, so small loads cannot starve it (round 2 #10)", () => {
    const old = NOW - CONFIG.loadYieldMs;
    const d = decide(view(50, [], [waiter("r", { since: old }), waiter("small")]), loadRequest({ bytes: 40 * GIB, since: old }), NOW, CONFIG);
    expect(d).toMatchObject({ grant: false, denial: "ram", yields: false });
    const short = { ...CONFIG, loadYieldMs: 5 };
    const fresh = decide(view(50, [], [waiter("r", { since: NOW - 4 }), waiter("small")]), loadRequest({ bytes: 40 * GIB, since: NOW - 4 }), NOW, short);
    expect(fresh.yields).toBe(true);
    const done = decide(view(50, [], [waiter("r", { since: NOW - 5 }), waiter("small")]), loadRequest({ bytes: 40 * GIB, since: NOW - 5 }), NOW, short);
    expect(done.yields).toBe(false);
  });

  it("loadBounds: upper = weights + KV for the tokens + 1 GiB headroom + extra, lower = weights + headroom; no context, no upper", () => {
    const est = { weight_bytes: 2 * GIB, kv_bytes_per_token: 1000 };
    expect(loadBounds(est, 4096, 3)).toEqual({ bytes: 2 * GIB + 4_096_000 + GIB + 3, minBytes: 3 * GIB });
    expect(loadBounds(est, 0)).toEqual({ bytes: 0, minBytes: 3 * GIB });
    // Round 5 M2(a): a Locals lower bound carries the smallest prompt cache; the upper bound already has its 4 GiB.
    expect(loadBounds(est, 4096, 3, 0.1 * GIB)).toEqual({ bytes: 2 * GIB + 4_096_000 + GIB + 3, minBytes: 3 * GIB + 0.1 * GIB });
  });

  it("a breach teaches a lower bound only, never the upper one: one spurious breach cannot fail a model that fits (round 4 #1)", () => {
    // What the watchdog saw grow, plus the headroom, never below the bound the load already had.
    expect(learnedLowerBound(GIB, 3 * GIB)).toBe(3 * GIB + WINDOW_HEADROOM_BYTES);
    expect(learnedLowerBound(10 * GIB, 3 * GIB)).toBe(10 * GIB);
    // The broker's bookkeeping: the count grows with each breach in a row and the bound with the largest seen; the
    // BREACHES_TO_FAIL-th fails the model, so retries are bounded without a never-fits.
    const first = afterBreach(undefined, 2 * GIB, 3 * GIB);
    expect(first).toEqual({ learned: { minBytes: 3 * GIB + WINDOW_HEADROOM_BYTES, breaches: 1 }, fail: false });
    const second = afterBreach(first.learned, 2 * GIB, GIB);
    expect(second).toEqual({ learned: { minBytes: 3 * GIB + WINDOW_HEADROOM_BYTES, breaches: 2 }, fail: false });
    expect(BREACHES_TO_FAIL).toBe(3);
    // Round 5 m5: the third fails the jobs but keeps the bound (and so the alone mark); only the count restarts.
    const third = afterBreach(second.learned, 2 * GIB, 4 * GIB);
    expect(third).toEqual({ learned: { minBytes: 4 * GIB + WINDOW_HEADROOM_BYTES, breaches: 0 }, fail: true });
    expect(afterBreach(third.learned, 2 * GIB, GIB)).toEqual({ learned: { minBytes: 4 * GIB + WINDOW_HEADROOM_BYTES, breaches: 1 }, fail: false });
    // A model whose upper bound is 60 GiB (over the 57.6 GiB that 90 % of 64 GiB allows) and lower 2 GiB: one breach after
    // 3 GiB of growth leaves it far under never-fits, where the old rule (the lower bound raised to the upper one) failed it.
    expect(neverFits(first.learned.minBytes, LIMITS, TOTAL)).toBe(false);
  });

  it("readyBooking: a Locals server is booked at ready by the most it can hold, never by its lower bound or 0 (round 5 M1)", () => {
    const est = { weight_bytes: 2 * GIB, kv_bytes_per_token: 1024 };
    // weights + KV for 4096 tokens + the 2.5 GiB cache it was given + headroom, over a 1 GiB grant and 0.5 GiB of growth.
    expect(readyBooking(GIB, est, 4096, 2.5, 0.5 * GIB)).toBe(2 * GIB + 4096 * 1024 + 2.5 * GIB + WINDOW_HEADROOM_BYTES);
    // The grant wins when it was larger; the growth the watchdog saw wins when the estimate understated the load.
    expect(readyBooking(20 * GIB, est, 4096, 2.5, 0)).toBe(20 * GIB);
    expect(readyBooking(0, est, 0, 0.1, 30 * GIB)).toBe(30 * GIB);
    // No figures at all: an error, never a silent 0.
    expect(() => readyBooking(0, null, 4096, 4, 0)).toThrow(/booked at 0/);
  });

  it("swapHeld: a reload pause after an unload, and one settle interval after no room for the prompt cache (round 5 M2)", () => {
    expect(swapHeld(NOW, NOW - 59_999, 60_000, undefined)).toBe("reload-pause");
    expect(swapHeld(NOW, NOW - 60_000, 60_000, undefined)).toBeNull();
    expect(swapHeld(NOW, undefined, 60_000, NOW + 1)).toBe("cache-room");
    expect(swapHeld(NOW, undefined, 60_000, NOW)).toBeNull();
    expect(swapHeld(NOW, undefined, 60_000, undefined)).toBeNull();
  });

  it.each([
    { name: "the alone flag waits for another owner's server, even with a bounded upper bound that fits", used: 10, servers: [server(5, { ownerPid: 7 })], alone: true, grant: false, denial: "alone" },
    { name: "without the flag the same load is granted beside it", used: 10, servers: [server(5, { ownerPid: 7 })], alone: false, grant: true, denial: null },
    { name: "alone, RAM is judged on the lower bound: granted where the upper one would not fit", used: 70, servers: [], alone: true, grant: true, denial: null },
    { name: "not alone, the upper bound decides: it waits on RAM", used: 70, servers: [], alone: false, grant: false, denial: "ram" },
  ])("decide, a load marked alone after a breach (round 4 #1): $name", ({ used, servers, alone, grant, denial }) => {
    // 14 GiB upper bound, 5 GiB lower: at 70 % of 64 GiB used, 12.8 GiB of room are left under 90 %.
    const d = decide({ ...view(used), servers }, loadRequest({ bytes: 14 * GIB, minBytes: 5 * GIB, alone }), NOW, CONFIG);
    expect({ grant: d.grant, denial: d.denial }).toEqual({ grant, denial });
    expect(neededBytes({ bytes: 14 * GIB, minBytes: 5 * GIB, alone }, LIMITS, TOTAL)).toBe(alone ? 5 * GIB : 14 * GIB);
  });

  it("localsCacheGb: at most 4, the room left under the limit beside the rest of the load; under 0.1 GiB null, never 0 (round 2 #5)", () => {
    expect(localsCacheGb(10 * GIB, 0, LIMITS, TOTAL)).toBe(4);
    expect(localsCacheGb(0.9 * TOTAL - 2.55 * GIB, 0, LIMITS, TOTAL)).toBe(2.5);
    expect(localsCacheGb(0.9 * TOTAL - 0.15 * GIB, 0, LIMITS, TOTAL)).toBe(0.1);
    // 0 would tell Locals "no bound" (service.py: `if cache_gb else None`), so too little room is a wait.
    expect(localsCacheGb(0.9 * TOTAL - 0.09 * GIB, 0, LIMITS, TOTAL)).toBeNull();
    expect(localsCacheGb(0.9 * TOTAL, 1, LIMITS, TOTAL)).toBeNull();
  });

  it("reloadAfterUnloadMs: 60 s by default; a malformed override is an error", () => {
    expect(reloadAfterUnloadMs({})).toBe(60_000);
    expect(reloadAfterUnloadMs({ LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS: "5" })).toBe(5);
    expect(() => reloadAfterUnloadMs({ LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS: "-1" })).toThrow(/positive integer/);
  });
});

describe("wantUnload choice (pure)", () => {
  it("picks the least recently used server with no inference running on it", () => {
    const servers = [server(1, { lastUsedAt: 50 }), server(2, { lastUsedAt: 10 }), server(3, { lastUsedAt: 30 })];
    expect(pickUnload(servers, [], 99, 0, NOW, 2_000)?.pid).toBe(2);
    // An inference on 2 makes it busy, not idle: the next oldest goes.
    expect(pickUnload(servers, [lease({ serverPid: 2 })], 99, 0, NOW, 2_000)?.pid).toBe(3);
    // A load lease is no inference: it names no server.
    expect(pickUnload(servers, [lease({ kind: "load", serverPid: 2 })], 99, 0, NOW, 2_000)?.pid).toBe(2);
  });

  it("never the requester's own server: its RAM is the outgoing share a swap already counts", () => {
    const servers = [server(1, { lastUsedAt: 1, ownerPid: 99 }), server(2, { lastUsedAt: 5 })];
    expect(pickUnload(servers, [], 99, 0, NOW, 2_000)?.pid).toBe(2);
  });

  it("one per settle interval; a flag older than that does not block the next choice (round 2 #2)", () => {
    const servers = [server(1, { lastUsedAt: 1 }), server(2, { lastUsedAt: 2 })];
    expect(pickUnload(servers, [], 99, NOW - 1_999, NOW, 2_000)).toBeNull();
    expect(pickUnload(servers, [], 99, NOW - 2_000, NOW, 2_000)?.pid).toBe(1);
    // A flag left by an owner that never acted: once the settle interval passed, the choice is made again.
    expect(pickUnload([server(1, { lastUsedAt: 1, wantUnload: true }), server(2)], [], 99, NOW - 2_000, NOW, 2_000)?.pid).toBe(1);
    expect(pickUnload([server(3, { ownerPid: 99 })], [], 99, 0, NOW, 2_000)).toBeNull();
  });

  it("unloads only when that makes room: the waiting load must fit once every idle server gave its RAM back (round 2 #9)", () => {
    const need = (bytes: number, ramUsedPct = 80) => ({ ramUsedPct, bytes, outgoingBytes: 0, limits: LIMITS, totalBytes: TOTAL });
    // 80 % of 64 GiB used, the limit 90 %: 6.4 GiB of room. llama servers: nothing booked, their weights given back.
    const servers = [server(1, { lastUsedAt: 1, residentBytes: 2 * GIB }), server(2, { lastUsedAt: 2, residentBytes: 3 * GIB }), server(3, { lastUsedAt: 0, residentBytes: 20 * GIB })];
    // 30 GiB needs every idle server's RAM (25 GiB) and more: unloading cannot help, so nothing is asked.
    expect(pickUnload(servers, [], 99, 0, NOW, 2_000, need(32 * GIB))).toBeNull();
    // 12 GiB fits once they are all back: the least recently used goes first.
    expect(pickUnload(servers, [], 99, 0, NOW, 2_000, need(12 * GIB))?.pid).toBe(3);
    // A busy server gives nothing back: without server 3's 20 GiB the same load cannot fit.
    expect(pickUnload(servers, [lease({ serverPid: 3 })], 99, 0, NOW, 2_000, need(12 * GIB))).toBeNull();
    // Round 4 #2: what a server gives back is its resident figure, never more; a llama server above gives its weights. A
    // Locals server booked at 20 GiB gives back exactly its booking: books and freed share cancel, the 6.4 GiB room stays.
    const locals = [server(7, { engine: "locals", bookedBytes: 20 * GIB, residentBytes: 20 * GIB })];
    expect(pickUnload(locals, [], 99, 0, NOW, 2_000, need(6 * GIB))?.pid).toBe(7);
    expect(pickUnload(locals, [], 99, 0, NOW, 2_000, need(7 * GIB))).toBeNull();
    // Round 4 #4: a cal server is never chosen, however old and large: its runner stops it itself and polls no flag.
    const cal = server(8, { lastUsedAt: -5, residentBytes: 40 * GIB, role: "cal" });
    expect(pickUnload([...servers, cal], [], 99, 0, NOW, 2_000, need(12 * GIB))?.pid).toBe(3);
    expect(pickUnload([cal], [], 99, 0, NOW, 2_000, need(1))).toBeNull();
    // Round 4 #7: RAM over its limit with no load waiting asks for 0 bytes: an unload only if it brings the books under
    // the limit. At 95 % (3.2 GiB over), 2 GiB back does not; 20 GiB does.
    expect(pickUnload([server(1, { residentBytes: 2 * GIB })], [], 99, 0, NOW, 2_000, need(0, 95))).toBeNull();
    expect(pickUnload([server(3, { residentBytes: 20 * GIB })], [], 99, 0, NOW, 2_000, need(0, 95))?.pid).toBe(3);
    // neededBytes: the lower bound when the upper one could never fit, else the upper one.
    expect(neededBytes({ bytes: 100 * GIB, minBytes: 9 * GIB }, LIMITS, TOTAL)).toBe(9 * GIB);
    expect(neededBytes({ bytes: 10 * GIB, minBytes: 9 * GIB }, LIMITS, TOTAL)).toBe(10 * GIB);
    expect(neededBytes({ bytes: 0, minBytes: 9 * GIB }, LIMITS, TOTAL)).toBe(9 * GIB);
  });
});

describe("load_estimate in the calibration record", () => {
  const base: RecordBase = {
    harness: "production",
    harness_version: 1,
    fixture_version: 1,
    engine: "llama",
    model: "a/b:Q4",
    fingerprint: { blobs: ["0".repeat(64)], ram_bytes: 1 },
    engine_version: "b1",
    engine_version_checked: "b1",
    calibrated_at: "2026-10-31T00:00:00.000Z",
    duration_s: 10,
  };
  const a = { step: "A/summary", data: { n_ctx_train: 4096, template_thinking: false, chars_per_token: 3, decode_tps: 10, prefill_tps_2k: 100, prefill_tps_8k: 100, thinking_on: false, json_off: true, json_on: true, array40: true } };
  const b = { step: "B/summary", data: { window_tokens: 4096, free_ram_bytes: 1e9, fill_fact: 2048, fill_aggregate: 2048, fill_bug: 2048, min_out_fact: 256, min_out_aggregate: 256, min_out_bug: 256, thinking_off_mode: true, grid: "[]" } };
  const c = { main_slots: 2, main_slot_ctx: 4096, aggregate_tps: 20, load_avg: 1, scout_candidates: "[]" };

  it("Phase C's figures become load_estimate, schema-valid, and survive a write and a read", () => {
    const r = okRecordFrom(base, [a, b, { step: "C/summary", data: { ...c, load_weight_bytes: 5 * GIB, load_kv_bytes_per_token: 73728 } }]);
    expect(r.load_estimate).toEqual({ weight_bytes: 5 * GIB, kv_bytes_per_token: 73728 });
    expect(recordSchemaErrors(r)).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "govload-rec-"));
    try {
      writeRecord(dir, r);
      expect(readRecord(dir, "llama", "a/b:Q4")?.load_estimate).toEqual(r.load_estimate);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a summary without them is a runner bug: no record is made; an ok record without load_estimate, or a malformed one, is refused (round 4 #8)", () => {
    expect(() => okRecordFrom(base, [a, b, { step: "C/summary", data: c }])).toThrow(/no C\/summary load_weight_bytes/);
    const r = okRecordFrom(base, [a, b, { step: "C/summary", data: { ...c, load_weight_bytes: 5 * GIB, load_kv_bytes_per_token: 1 } }]);
    expect(recordSchemaErrors({ ...r, load_estimate: undefined })).toContain("load_estimate {weight_bytes, kv_bytes_per_token}");
    expect(recordSchemaErrors({ ...r, load_estimate: { weight_bytes: -1, kv_bytes_per_token: 1 } } as unknown as CalibrationRecord)).toContain("load_estimate {weight_bytes, kv_bytes_per_token}");
  });

  it("an ok record without load_estimate, or of harness version 5, is missing even with its weights on disk: recalibrated once, never sized from the files (round 4 #8)", () => {
    const dir = mkdtempSync(join(tmpdir(), "govload-est-"));
    try {
      const file = join(dir, "m.gguf");
      // 4 layers, 2 KV heads, head size 512 / 8 = 64: K + V = 2 x 64 x 2 heads x 2 bytes x 4 layers = 2048 bytes a token.
      writeGguf(file, [
        ["general.architecture", "llama"],
        ["llama.block_count", 4],
        ["llama.attention.head_count", 8],
        ["llama.embedding_length", 512],
        ["llama.attention.head_count_kv", 2],
      ]);
      // The cal server before any record still reads the figures from the files (estimateOnDisk).
      expect(weightFilesOnDisk("llama", file, null)).toEqual([file]);
      expect(estimateFromFiles("llama", [file])).toEqual({ weight_bytes: statSync(file).size, kv_bytes_per_token: 2048 });
      // An org/repo:quant tag names no file before llama.cpp picks one; with no record fingerprint it is unknown.
      expect(weightFilesOnDisk("llama", "nobody-here/none:Q4_K_M", null)).toBeNull();
      expect(weightFilesOnDisk("llama", join(dir, "absent.gguf"), null)).toBeNull();
      // Round 4 #10: a vanished file (ENOENT) is unknown; any other read error is thrown, never an unknown size.
      expect(estimateFromFiles("llama", [join(dir, "vanished.gguf")])).toBeNull();
      expect(() => estimateFromFiles("llama", [dir])).toThrow(/EISDIR/);

      // The record file is written by hand: writeRecord refuses a record that fails the schema.
      const write = (rec: object): void => {
        mkdirSync(dirname(recordPath(dir, "llama", file)), { recursive: true });
        writeFileSync(recordPath(dir, "llama", file), JSON.stringify(rec));
      };
      write({ ...recordFixture("llama", file), load_estimate: undefined });
      expect(readRecordStatus(dir, "llama", file).state).toBe("missing");
      writeRecord(dir, { ...recordFixture("llama", file), harness_version: 5 });
      expect(readRecordStatus(dir, "llama", file).state).toBe("missing");
      writeRecord(dir, recordFixture("llama", file));
      expect(readRecordStatus(dir, "llama", file).state).toBe("ok");
      expect(HARNESS_VERSION).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the governor's own state: a RAM-denied load asks for an idle server back", () => {
  let dir: string;
  const saved = { ...process.env };
  const children: ChildProcess[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "govload-"));
    process.env.LLM_EXT_GOVERNOR_DIR = dir;
    process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = "90";
    process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT = "100";
    // Long, so the test sees "one per settle interval" hold across its passes.
    process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "600000";
  });
  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    for (const key of Object.keys(process.env)) if (key.startsWith("LLM_EXT_GOVERNOR_")) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith("LLM_EXT_GOVERNOR_")) process.env[key] = value;
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks the least recently used idle server of another owner, never a busy one or the requester's own, and one per settle interval", async () => {
    // A live owner that is not this process: the reap keeps a server only while its owner lives.
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    children.push(owner);
    const other = { ownerPid: owner.pid as number, ownerStart: "" };
    withStateLock(dir, (s) => {
      s.servers.push(
        // Each gives back the whole machine: giving one back makes room, so it is worth asking for (round 2 #9).
        server(900_001, { ...other, lastUsedAt: 10, residentBytes: totalmem() }),
        server(900_002, { ...other, lastUsedAt: 20, residentBytes: totalmem() }),
        server(900_003, { ...other, lastUsedAt: 1 }),
        server(900_004, { ownerPid: process.pid, ownerStart: "", lastUsedAt: 0 }),
      );
      // An inference on the oldest of the others: busy, so not idle.
      s.leases.push(lease({ id: "busy", serverPid: 900_003, holder: { pid: owner.pid as number, start: "" }, expiresAt: Date.now() + 600_000 }));
    });
    // All but 1 GiB of what the limit allows: it fits the machine (a wait, not a never-fits), and never beside the RAM a
    // running machine uses. Sized against the limit, not a reading: other programs moving RAM cannot make it fit.
    const bytes = 0.9 * totalmem() - GIB;
    expect(neverFits(bytes, { ...LIMITS, ramLimitPct: 90 }, totalmem())).toBe(false);
    const deadline = Date.now() + 30_000;
    let denial: string | null = null;
    while (denial !== "ram") {
      if (Date.now() > deadline) throw new Error(`no RAM denial after 30 s, last ${String(denial)}`);
      const got = gov.attemptLease({ kind: "load", timeoutMs: 60_000, bytes });
      if (got.lease) throw new Error("a load sized to the whole limit was granted");
      denial = got.denial;
      await new Promise((r) => setTimeout(r, 100));
    }
    const flagged = (): number[] => JSON.parse(readFileSync(join(dir, "state-1.json"), "utf8")).servers.filter((s: ServerEntry) => s.wantUnload).map((s: ServerEntry) => s.pid);
    expect(flagged()).toEqual([900_001]);
    expect(gov.unloadWanted(900_001)).toBe(true);
    expect(gov.unloadWanted(900_002)).toBe(false);
    // Still denied, the flagged one gone: the settle interval keeps the next one in place.
    gov.unregisterServer(900_001);
    await new Promise((r) => setTimeout(r, 100));
    expect(gov.attemptLease({ kind: "load", timeoutMs: 60_000, bytes }).denial).toBe("ram");
    expect(flagged()).toEqual([]);
    // A load that fits is granted at once, the projection and nothing else being the difference.
    gov.withdraw("load");
    let granted: gov.AttemptResult = { lease: null, denial: null, reason: null };
    while (!granted.lease) {
      if (Date.now() > deadline + 30_000) throw new Error("a small load was never granted");
      granted = gov.attemptLease({ kind: "load", timeoutMs: 60_000, bytes: GIB });
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(granted.lease.bytes).toBe(GIB);
    gov.release(granted.lease);
  }, 120_000);

  it("a flagged server that takes work is unflagged, and an expired flag does not stop the next choice (round 2 #2)", async () => {
    process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "300";
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    children.push(owner);
    const other = { ownerPid: owner.pid as number, ownerStart: "" };
    // Each idle server gives back all the machine's RAM, so giving either back would make room (round 2 #9).
    withStateLock(dir, (s) => {
      s.servers.push(server(900_011, { ...other, lastUsedAt: 1, residentBytes: totalmem() }), server(900_012, { ...other, lastUsedAt: 2, residentBytes: totalmem() }));
    });
    const bytes = 0.9 * totalmem() - GIB;
    const flagged = (): number[] => JSON.parse(readFileSync(join(dir, "state-1.json"), "utf8")).servers.filter((s: ServerEntry) => s.wantUnload).map((s: ServerEntry) => s.pid);
    const deadline = Date.now() + 30_000;
    while (flagged().length === 0) {
      if (Date.now() > deadline) throw new Error("no server was flagged");
      if (gov.attemptLease({ kind: "load", timeoutMs: 60_000, bytes }).lease) throw new Error("a load sized to the whole limit was granted");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(flagged()).toEqual([900_011]);
    // Its owner takes an inference on it: in use, so the flag is withdrawn at the grant.
    let inference: gov.AttemptResult = { lease: null, denial: null, reason: null };
    while (!inference.lease) {
      if (Date.now() > deadline) throw new Error(`the inference was never granted (${String(inference.denial)})`);
      inference = gov.attemptLease({ kind: "inference", timeoutMs: 60_000, serverPid: 900_011 });
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(flagged()).toEqual([]);
    gov.release(inference.lease);
    // The next settle interval picks again: 900_011 is the least recently used no more (the inference touched it).
    while (flagged().length === 0) {
      if (Date.now() > deadline) throw new Error("no second choice after the flag was withdrawn");
      gov.attemptLease({ kind: "load", timeoutMs: 60_000, bytes });
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(flagged()).toEqual([900_012]);
    // Nobody acts on it: after one settle interval the flag expires and the choice is made again, never stuck on it.
    withStateLock(dir, (s) => {
      for (const e of s.servers) if (e.pid === 900_012) e.lastUsedAt = 3;
      for (const e of s.servers) if (e.pid === 900_011) e.lastUsedAt = 0;
    });
    await new Promise((r) => setTimeout(r, 400));
    const after = Date.now() + 5_000;
    while (!flagged().includes(900_011)) {
      if (Date.now() > after) throw new Error(`the expired flag held the choice: ${JSON.stringify(flagged())}`);
      gov.attemptLease({ kind: "load", timeoutMs: 60_000, bytes });
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(flagged()).toEqual([900_011]);
    gov.withdraw("load");
  }, 120_000);

  it("a state file without lastUnloadAt or ramOverSince (an older dev build: the governor never shipped without them) is replaced as corrupt (round 4 #9)", () => {
    const held = lease({ id: "old", kind: "load", holder: { pid: process.pid, start: "" }, expiresAt: Date.now() + 600_000 });
    for (const field of ["lastUnloadAt", "ramOverSince"] as const) {
      const old = { ...emptyState(), leases: [held] } as Partial<ReturnType<typeof emptyState>>;
      delete old[field];
      writeFileSync(join(dir, "state-1.json"), JSON.stringify(old), { mode: 0o600 });
      const s = readState(dir);
      expect(s.leases).toEqual([]);
      expect({ lastUnloadAt: s.lastUnloadAt, ramOverSince: s.ramOverSince }).toEqual({ lastUnloadAt: 0, ramOverSince: null });
    }
    // Round 5 m2: a server entry missing a figure, or with a wrong engine or role, makes the file not whole either.
    for (const bad of [{ bookedBytes: undefined }, { residentBytes: "1" }, { engine: "ollama" }, { role: "other" }, { wantUnload: 1 }, { pid: Number.NaN }]) {
      writeFileSync(join(dir, "state-1.json"), JSON.stringify({ ...emptyState(), leases: [held], servers: [{ ...server(5), ...bad }] }), { mode: 0o600 });
      expect(readState(dir).leases).toEqual([]);
    }
    writeFileSync(join(dir, "state-1.json"), JSON.stringify({ ...emptyState(), leases: [held], servers: [server(5)] }), { mode: 0o600 });
    expect(readState(dir).servers.map((s) => s.pid)).toEqual([5]);
    // A whole one keeps its lease.
    writeFileSync(join(dir, "state-1.json"), JSON.stringify({ ...emptyState(), leases: [held] }), { mode: 0o600 });
    expect(readState(dir).leases.map((l) => l.id)).toEqual(["old"]);
  });

  it("RAM over its limit for 30 s with no load waiting unloads an idle server only if giving it back brings the books under the limit (round 4 #7)", async (ctx) => {
    // Precondition: real RAM must be over the 50 % limit, the lowest the governor accepts, so the test needs at least 55 % used.
    const used = (await readMemory()).usedPct;
    // WHY skip, not throw: an unmet hardware precondition is not a product failure. The limit cannot go below 50 %, so real RAM has to be over it; the skip note carries the live reading so the gap stays visible.
    if (used < 55) ctx.skip(`this machine is ${used.toFixed(1)} % used; the test needs at least 55 % so the real reading sits over the lowest allowed RAM limit (50 %) with margin`);
    process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = "50";
    process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "300";
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    children.push(owner);
    const other = { ownerPid: owner.pid as number, ownerStart: "" };
    const flagged = (): number[] => JSON.parse(readFileSync(join(dir, "state-1.json"), "utf8")).servers.filter((s: ServerEntry) => s.wantUnload).map((s: ServerEntry) => s.pid);
    // 1 MiB back cannot bring the books under 50 %; RAM has been over since 31 s ago.
    withStateLock(dir, (s) => {
      s.servers.push(server(900_021, { ...other, lastUsedAt: 1, residentBytes: 2 ** 20 }));
      s.ramOverSince = Date.now() - 31_000;
    });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const got = gov.attemptLease({ kind: "inference", timeoutMs: 60_000 });
      if (got.lease) gov.release(got.lease);
      await new Promise((r) => setTimeout(r, 100));
    }
    // The reading was taken (the RAM-over clock kept running from 31 s ago) and nothing was asked back.
    const state = JSON.parse(readFileSync(join(dir, "state-1.json"), "utf8")) as { ramOverSince: number | null; metrics: { freePct: number | null } };
    expect(state.metrics.freePct).not.toBeNull();
    expect(state.ramOverSince).not.toBeNull();
    expect(flagged()).toEqual([]);
    // The same server giving back the whole machine would bring it under: it is asked.
    withStateLock(dir, (s) => {
      for (const e of s.servers) e.residentBytes = totalmem();
    });
    const after = Date.now() + 10_000;
    while (!flagged().includes(900_021)) {
      if (Date.now() > after) {
        gov.withdraw("inference");
        throw new Error("a server that makes room was never asked back while RAM was over its limit");
      }
      const got = gov.attemptLease({ kind: "inference", timeoutMs: 60_000 });
      if (got.lease) gov.release(got.lease);
      await new Promise((r) => setTimeout(r, 100));
    }
    gov.withdraw("inference");
  }, 60_000);

  it("loadVerdict keeps this broker's own load waiter at its real place: at the head it is no 'queued' (round 4 #11)", () => {
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
    children.push(owner);
    const now = Date.now();
    const me = { pid: process.pid, start: "" };
    withStateLock(dir, (s) => {
      s.metrics = { at: now, cpuSample: null, cpuPct: 10, freePct: 90 };
      // This process's own waiter first, another owner's load waiter behind it.
      s.waiters.push(waiter(`${process.pid}:load`, { holder: me, since: now, polledAt: now }), waiter(`${owner.pid}:load`, { holder: { pid: owner.pid as number, start: "" }, since: now, polledAt: now }));
    });
    expect(gov.loadVerdict({ timeoutMs: 60_000, bytes: 2 ** 20, minBytes: 2 ** 20 })).toBeNull();
    // Behind the other one, it is "queued", which shows the verdict reads the real order.
    withStateLock(dir, (s) => {
      s.waiters.reverse();
    });
    expect(gov.loadVerdict({ timeoutMs: 60_000, bytes: 2 ** 20, minBytes: 2 ** 20 })).toBe("queued");
  });
  it("a server entry is judged by its owner only: its empty start string is never compared, so it cannot be reaped as a reused pid (round 2 #7)", () => {
    const s = { ...emptyState(), servers: [server(4242, { ownerPid: 77, ownerStart: "Mon" })] };
    // The server's own pid is dead and its start differs: still kept, its owner (alive, same start) answers for it.
    reap(s, NOW, new Map([[77, "Mon"], [4242, "Tue"]]), (pid) => pid === 77);
    expect(s.servers.map((e) => e.pid)).toEqual([4242]);
    // The owner gone: the entry goes with it.
    reap(s, NOW, null, () => false);
    expect(s.servers).toEqual([]);
  });
});

describe("the load watchdog (the machine's real RAM reading)", () => {
  // The limit is placed against the live reading, not reached by allocating. Round 3 tried the real thing: with the
  // vm_stat reading (which does track an anonymous allocation within 1 to 2 s, reports_dev/governor/
  // 20261031_144619+0100-ram-reading-measure.md) a 3 GiB incompressible allocation was pushed over a limit 1 GiB above
  // the reading, and the watchdog never fired: the reading fell from 84.4 % to 77.6 % meanwhile, other programs on this
  // shared machine giving back about 4.5 GiB. A test that waits for an allocation to cross a limit cannot be made
  // reliable here. What it pins is the rule: at or over the limit it fires once, below it never.
  it("fires once a reading is at or over the limit, with the growth it saw, and stops watching; under the limit it never fires", async () => {
    let quiet = 0;
    const control = await watchLoad({ ...LIMITS, ramLimitPct: 99 }, () => quiet++, 200);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(control.stop()).toBeGreaterThanOrEqual(0);
    expect(quiet).toBe(0);

    const { usedPct } = await readMemory();
    const seen: number[] = [];
    const watch = await watchLoad({ ...LIMITS, ramLimitPct: Math.max(1, Math.floor(usedPct) - 1) }, (observed) => seen.push(observed), 200);
    const deadline = Date.now() + 60_000;
    while (seen.length === 0) {
      if (Date.now() > deadline) throw new Error("the watchdog never fired");
      await new Promise((r) => setTimeout(r, 50));
    }
    // More ticks pass: a breach is reported once, then the watch has stopped itself.
    await new Promise((r) => setTimeout(r, 1_000));
    watch.stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("stops the load after 3 failed readings in a row, with the error; fewer, or failures broken by a good reading, do not (round 2 #3)", async () => {
    // The reading itself, made to fail on cue: the first call (the baseline) answers, then the script decides.
    const scripted = (script: Array<"ok" | "fail">) => {
      let i = 0;
      return async (): Promise<{ usedPct: number }> => {
        const step = i === 0 ? "ok" : (script[i - 1] ?? "ok");
        i++;
        if (step === "fail") throw new Error("vm_stat failed: exit 1");
        return { usedPct: 10 };
      };
    };
    const run = async (script: Array<"ok" | "fail">): Promise<Array<{ observed: number; failure: string | null }>> => {
      const seen: Array<{ observed: number; failure: string | null }> = [];
      const watch = await watchLoad({ ...LIMITS, ramLimitPct: 99 }, (observed, failure) => seen.push({ observed, failure: failure?.message ?? null }), 20, scripted(script));
      await new Promise((r) => setTimeout(r, 20 * (script.length + 5)));
      watch.stop();
      return seen;
    };
    expect(await run(["fail", "fail", "ok", "fail", "fail", "ok"])).toEqual([]);
    const stopped = await run(["ok", "fail", "fail", "fail", "ok", "ok"]);
    expect(stopped).toHaveLength(1);
    expect(stopped[0].failure).toMatch(/the RAM reading failed 3 times in a row while a model loaded: vm_stat failed: exit 1/);
  }, 30_000);
});
// ── Real brokers on the two tiny GGUF models (the harness of broker-governor.test.ts) ──

const nodeExternals = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)];
const REQUIRE_SHIM = `import { createRequire as __cjsCreateRequire } from "node:module";\nconst require = __cjsCreateRequire(import.meta.url);\n`;
const ENTRY = `import { runBrokerMain } from "../broker/server.ts";\nawait runBrokerMain("t1");\n`;

interface Reply {
  state: string;
  status?: number;
  error?: string;
  dispatchedAt?: number;
  finishedAt?: number;
}

let workDir: string;
let bundle: string;
let governorDir: string;
const dirs: string[] = [];
const identities = new Map<string, LoadedIdentity>();
const savedEnv = { ...process.env };

async function withLlamaCache<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.LLAMA_CACHE;
  process.env.LLAMA_CACHE = LLAMA_CACHE;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.LLAMA_CACHE;
    else process.env.LLAMA_CACHE = saved;
  }
}

/**
 * Every cal server this file starts, by its own `stop`, handed over by startCalServer's onClaimed at the spawn (so also
 * while it still loads). WHY: a llama-server (tiny-llamas stories260K) survived 3 days orphaned (ppid 1) because the
 * "two dirs never load at once" test awaited its cal server only after the replies; when they threw or the vitest
 * timeout hit, nothing stopped it, and rmSync(scratch) deleted the registry the product's per-config-dir orphan sweep
 * needs to find it again. stopTrackedCals runs in the test's finally, and in afterEach/afterAll for the timeout case
 * where a finally never runs. `stop` is idempotent (a dead pid only releases the entry), so a server the test already
 * stopped costs nothing.
 */
const calStops = new Set<(why: string) => Promise<void>>();

function startTrackedCal(scratch: string, model: string): Promise<CalServer> {
  return withLlamaCache(() => startCalServer(scratch, "llama", model, 1024, 1, () => undefined, (s) => calStops.add(s.stop)));
}

/** Stops every tracked cal server, all of them even when one fails, then throws the first failure (never swallowed). */
async function stopTrackedCals(): Promise<void> {
  const stops = [...calStops];
  calStops.clear();
  const results = await Promise.allSettled(stops.map((stop) => stop("test cleanup")));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

async function measure(model: string): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "llm-ext-govload-measure-"));
  try {
    await withLlamaCache(async () => {
      const s = await startTrackedCal(scratch, model);
      try {
        identities.set(model, await loadedIdentity("llama", s.baseUrl, s.apiKey, model, scratch));
      } finally {
        await s.stop("measured");
      }
    });
  } finally {
    // Before rmSync(scratch), which deletes the registry stop() releases its entry in: a measure that throws or times out
    // while the server loads must not leave it behind (3-day orphan, see calStops). A no-op after the normal stop above.
    try {
      await stopTrackedCals();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

function okRecord(model: string, over: Partial<CalibrationRecord> = {}): CalibrationRecord {
  const id = identities.get(model)!;
  return { ...recordFixture("llama", model), fingerprint: id.fingerprint, engine_version: id.engineVersion, engine_version_checked: id.engineVersion, ...over };
}

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "llm-ext-govload-cfg-"));
  dirs.push(d);
  for (const m of [A, B]) writeRecord(d, okRecord(m));
  return d;
}

/** CPU off and a short settle interval: RAM and the projection are what these tests are about. */
function governorLimits(env: Record<string, string> = {}): void {
  process.env.LLM_EXT_GOVERNOR_CPU_LIMIT_PCT = "100";
  process.env.LLM_EXT_GOVERNOR_RAM_LIMIT_PCT = "90";
  process.env.LLM_EXT_GOVERNOR_SETTLE_MS = "100";
  process.env.LLM_EXT_GOVERNOR_MAX_INFERENCES = "2";
  Object.assign(process.env, env);
}

const startBroker = (dir: string, env: Record<string, string> = {}): Promise<BrokerEndpoint> =>
  ensureBroker({ dir, version: "t1", entry: bundle, env: { ...process.env, LLAMA_CACHE, ...env } });

async function submit(ep: BrokerEndpoint, model: string, o: { queueTimeoutMs?: number; maxTokens?: number } = {}): Promise<string> {
  const res = await fetch(`${ep.url}/v1/jobs`, {
    method: "POST",
    headers: {
      [TOKEN_HEADER]: ep.token,
      [ENGINE_HEADER]: "llama",
      [CTX_HEADER]: "1024",
      [COMMAND_HEADER]: "test",
      [TIMEOUT_HEADER]: "120000",
      ...(o.queueTimeoutMs === undefined ? {} : { [QUEUE_TIMEOUT_HEADER]: String(o.queueTimeoutMs) }),
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Once upon a time" }], max_tokens: o.maxTokens ?? 4 }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { job: string }).job;
}

async function outcome(ep: BrokerEndpoint, id: string, ms = DEADLINE_MS): Promise<Reply> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`job ${id} had no outcome after ${ms} ms`);
    const res = await fetch(`${ep.url}/v1/jobs/${id}?wait=5`, { headers: { [TOKEN_HEADER]: ep.token } });
    if (res.status === 204) continue;
    expect(res.status).toBe(200);
    return (await res.json()) as Reply;
  }
}

// WHY the optional diagnostics (TRDD-36L97JC9): Linux CI run 43983678292 gave up waiting on RAM with the cause
// unknown, because the broker log is not in the CI output. A caller now passes the log tails it needs, so the next
// timeout names the cause in the error itself. The condition and the deadline are unchanged.
async function until(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = DEADLINE_MS,
  diagnostics?: () => string,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      const extra = diagnostics ? `\n${diagnostics()}` : "";
      throw new Error(`gave up after ${ms} ms waiting for ${what}${extra}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const brokerLog = (dir: string): string => {
  const log = join(dir, "broker-local.log");
  return existsSync(log) ? readFileSync(log, "utf8") : "";
};
const spawnCount = (dir: string): number => brokerLog(dir).split("\n").filter((l) => l.includes(SPAWN_MARKER)).length;

/** The last 40 lines of a dir's broker log, appended to a timeout message. */
const logTail = (dir: string): string => brokerLog(dir).split("\n").slice(-40).join("\n");

/** The time of the first broker log line matching `re`, from its ISO prefix. */
const loggedAt = (dir: string, re: RegExp): number | null => {
  const line = brokerLog(dir).split("\n").find((l) => re.test(l));
  return line ? Date.parse(line.split(" ")[0]) : null;
};

async function stopBroker(dir: string): Promise<void> {
  const st = readBrokerState(dir);
  if (st && (await isBrokerProcess(st.pid))) {
    process.kill(st.pid, "SIGTERM");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await isBrokerProcess(st.pid))) await new Promise((r) => setTimeout(r, 100));
    if (await isBrokerProcess(st.pid)) process.kill(st.pid, "SIGKILL");
  }
}

describe("model loads through the governor, real brokers (two tiny GGUF models)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "llm-ext-govload-bundle-"));
    bundle = join(workDir, "broker-entry.mjs");
    await build({
      stdin: { contents: ENTRY, resolveDir: HERE, sourcefile: "entry.ts", loader: "ts" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      banner: { js: REQUIRE_SHIM },
      external: nodeExternals,
      outfile: bundle,
    });
    for (const m of [A, B]) await measure(m);
  }, TEST_MS);

  afterAll(async () => {
    // A timed-out beforeAll leaves its measure() cal server behind (3-day orphan, see calStops).
    await stopTrackedCals();
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A name without the /llm[-_]?ext/ leak marker, as test-hermetic-config.ts does for its own.
    governorDir = mkdtempSync(join(tmpdir(), "govld-"));
    process.env.LLM_EXT_GOVERNOR_DIR = governorDir;
  });

  afterEach(async () => {
    try {
      // First, while every scratch dir still exists: a test that timed out never ran its own finally (3-day orphan, see calStops).
      await stopTrackedCals();
      while (dirs.length) {
        const dir = dirs.pop()!;
        await stopBroker(dir);
        const rows = await processSnapshot();
        for (const entry of readRegistry(dir, "llama")) {
          const row = rows.find((r) => r.pid === entry.pid);
          if (row && (basename(row.argv[0] ?? "") === "llama-server" || isLocalsServerArgv(row.argv))) process.kill(-entry.pgid, "SIGKILL");
        }
        // 60 s, not 15: a broker stopping its server at a load average near 100 was measured to need more than 15.
        await until("the servers of this dir to be gone", async () => !(await processSnapshot()).some((r) => r.command.includes(dir)), 60_000);
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      for (const key of Object.keys(process.env)) if (key.startsWith("LLM_EXT_GOVERNOR_")) delete process.env[key];
      for (const [key, value] of Object.entries(savedEnv)) if (key.startsWith("LLM_EXT_GOVERNOR_")) process.env[key] = value;
      rmSync(governorDir, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("a model that can never fit fails at once as a model error naming the figures, and nothing is spawned", async () => {
    governorLimits();
    const dir = newDir();
    writeRecord(dir, okRecord(A, { load_estimate: { weight_bytes: 2 * totalmem(), kv_bytes_per_token: 0 } }));
    const ep = await startBroker(dir);
    const reply = await outcome(ep, await submit(ep, A), 30_000);
    expect(reply.state).toBe("failed");
    expect(reply.error).toMatch(/needs about \d+ MiB of RAM to load, more than the \d+ MiB that ram_limit_pct 90% allows/);
    expect(reply.dispatchedAt).toBeUndefined();
    expect(spawnCount(dir)).toBe(0);
    expect(gov.snapshot().waiters).toEqual([]);
  }, TEST_MS);

  it("an upper bound over the limit with a lower bound under it is no model error: it waits while an inference runs, then loads alone (round 2 #1)", async () => {
    governorLimits();
    const dir = newDir();
    // Weights tiny, KV a whole machine per token: the upper bound is far over 90 %, the lower one (weights + 1 GiB) is not.
    writeRecord(dir, okRecord(A, { load_estimate: { weight_bytes: 1024 ** 2, kv_bytes_per_token: totalmem() } }));
    const busy = await gov.acquire({ kind: "inference", timeoutMs: DEADLINE_MS });
    let id: string;
    try {
      const ep = await startBroker(dir);
      id = await submit(ep, A);
      await until("the load to wait to run alone", () => /waits for a load grant \(the model may not fit beside anything else/.test(brokerLog(dir)), 60_000);
      expect(spawnCount(dir)).toBe(0);
      gov.release(busy);
      expect(await outcome(ep, id)).toMatchObject({ state: "done", status: 200 });
    } finally {
      gov.release(busy);
    }
    expect(spawnCount(dir)).toBe(1);
  }, TEST_MS);
  it("two dirs never load at once: brokers and a cal server each take the one load grant, held to ready", async () => {
    governorLimits();
    const configs = [newDir(), newDir(), newDir()];
    const eps = await Promise.all(configs.map((d) => startBroker(d)));
    const scratch = mkdtempSync(join(tmpdir(), "llm-ext-govload-cal-"));
    let cal: Promise<CalServer> | undefined;
    const seen = new Map<string, Lease>();
    /** Round 4 #4: the cal server of this process, as the governor booked it while it lived. */
    const calEntries = new Set<number>();
    let atOnce = 0;
    const sampler = setInterval(() => {
      const snap = { ...gov.snapshot(), servers: readState(governorDir).servers };
      const loads = snap.leases.filter((l) => l.kind === "load");
      for (const s of snap.servers) if (s.role === "cal" && s.ownerPid === process.pid) calEntries.add(s.pid);
      atOnce = Math.max(atOnce, loads.length);
      for (const l of loads) seen.set(l.id, l);
    }, 5);
    try {
      // Tracked from its claim: the finally below and afterEach stop it if the replies throw or the test times out (3-day orphan, see calStops).
      cal = startTrackedCal(scratch, B);
      const replies = await Promise.all(eps.map(async (ep, i) => outcome(ep, await submit(ep, i % 2 === 0 ? A : B))));
      const s = await cal;
      // Stopped whatever the assertion says, so a failing run leaks no cal server.
      try {
        expect(calEntries).toEqual(new Set([s.entry.pid]));
      } finally {
        await s.stop("measured");
      }
      // Forgotten at its stop: no cal entry outlives the server (round 4 #4, #5).
      expect(readState(governorDir).servers.filter((e) => e.pid === s.entry.pid)).toEqual([]);
      expect(replies.filter((r) => r.state !== "done")).toEqual([]);
    } finally {
      clearInterval(sampler);
      try {
        // Before rmSync(scratch): that deletes the registry the product orphan sweep needs to find a leftover cal server (3-day orphan).
        // Stop what is claimed, let a cal still waiting for its load grant settle (it is then claimed), stop that too.
        await stopTrackedCals();
        await cal?.catch(() => undefined);
        await stopTrackedCals();
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    expect(atOnce).toBe(1);
    // Every load was seen holding its grant: 3 brokers and the cal server of this process (D11, Phase C's restart path).
    expect(new Set([...seen.values()].map((l) => l.holder.pid))).toEqual(new Set([...eps.map((e) => e.pid), process.pid]));
    expect([...seen.values()].every((l) => l.expiresAt - l.at >= LOAD_LEASE_MS)).toBe(true);
    await until("every lease to go", () => gov.snapshot().leases.length === 0, 10_000);
  }, TEST_MS);

  it("a swap whose load is denied keeps serving the loaded model's queue, then loads at the grant (unit 2 review)", async () => {
    governorLimits();
    const dir = newDir();
    const ep = await startBroker(dir, { LLM_EXT_BROKER_BATCH: "1", LLM_EXT_BROKER_STARVE_MS: "600000" });
    expect(await outcome(ep, await submit(ep, A))).toMatchObject({ state: "done" });
    // A load of known size: one of unknown size (no bytes) would run alone and have A's idle server asked back (round 2 #4).
    const block = await gov.acquire({ kind: "load", timeoutMs: DEADLINE_MS, bytes: GIB, minBytes: GIB });
    let b: string;
    let aReplies: Reply[];
    try {
      // B's deadline is past from the start and A has served its minimum slice: a swap to B is due at once.
      b = await submit(ep, B, { queueTimeoutMs: 1 });
      const a = await Promise.all(Array.from({ length: 6 }, () => submit(ep, A, { maxTokens: 30 })));
      aReplies = await Promise.all(a.map((id) => outcome(ep, id, 120_000)));
      expect(spawnCount(dir)).toBe(1);
      expect(brokerLog(dir)).toMatch(/model 'ggml-org\/tiny-llamas\/stories260K.gguf' waits for a load grant \(another model is loading on this machine\)/);
    } finally {
      gov.release(block);
    }
    expect(aReplies.filter((r) => r.state !== "done")).toEqual([]);
    expect(await outcome(ep, b)).toMatchObject({ state: "done", status: 200 });
    expect(spawnCount(dir)).toBe(2);
  }, TEST_MS);

  it("RAM: a load that does not fit waits and names RAM; idle servers of other dirs give theirs back oldest first and do not reload at once; a smaller projection then loads", async () => {
    const reloadMs = 8_000;
    // A long yield bound: B's head must keep stepping aside for old's reload below however slow the machine is (round 2 #10).
    // ram_limit_pct 99: the round 3 reading (anonymous + wired + compressor) sits at 78 to 85 % on this shared machine, so
    // 90 % left too little room for two booked A servers (measured: the test stopped at its room check).
    governorLimits({ LLM_EXT_GOVERNOR_RAM_LIMIT_PCT: "99", LLM_EXT_GOVERNOR_RELOAD_AFTER_UNLOAD_MS: String(reloadMs), LLM_EXT_GOVERNOR_LOAD_YIELD_MS: "600000" });
    const [old, recent, waiting] = [newDir(), newDir(), newDir()];
    // Round 2 #9: an idle server is asked back only when that makes room, so the books must say it does. With L what 99 %
    // allows and U the reading now, each A server's upper bound is a = L - U - 2 GiB (it fits, 2 GiB to spare for other
    // programs), and B's is L - U + delta: over the room now, and inside it once both idle A servers give back their weights
    // (pickUnload frees residentBytes, a llama server's weight bytes a - 1 GiB, load.ts loadFigures; a llama server books 0).
    // Real RAM of the tiny models is far less: the reading barely moves, so it is the books that decide, as for a real model.
    const L = 0.99 * totalmem();
    const U = ((await readMemory()).usedPct / 100) * totalmem();
    const a = L - U - 2 * GIB;
    if (a < 2 * GIB) throw new Error(`the machine has too little room under 99 % for this test: ${Math.round((L - U) / GIB)} GiB`);
    // CI run 43983678292 (2026-11-17, Linux runner): delta was a / 2, which puts B over L itself when U < a / 2 (a lightly
    // used machine). A load over the whole limit never fits (neverFits, controller.ts): it takes the "alone" branch and the
    // broker logs "may not fit beside anything else", so the RAM wait below never came. B must lie in (L - U, L]: over the
    // room now (a llama server books 0, so the room is the reading's), not over the limit. That window is U wide whatever L
    // is, and CI run 44037104295 measured U at about 1 GiB on the runner, so delta < U by 1/8 GiB (neverFits compares two
    // fixed figures and needs no more), and delta >= 1/4 GiB keeps B over the room if the reading drifts down. On a busy
    // machine (this Mac, U at 78 to 85 %) a / 2 is the smaller, as before.
    const delta = Math.min(a / 2, U - GIB / 8);
    if (delta < GIB / 4) throw new Error(`the machine uses too little RAM for this test: B could not stay over the room and under the 99 % limit (${Math.round(U / 2 ** 20)} MiB used)`);
    for (const d of [old, recent]) writeRecord(d, okRecord(A, { load_estimate: { weight_bytes: a - GIB, kv_bytes_per_token: 0 } }));
    const epOld = await startBroker(old);
    expect(await outcome(epOld, await submit(epOld, A))).toMatchObject({ state: "done" });
    const epRecent = await startBroker(recent);
    expect(await outcome(epRecent, await submit(epRecent, A))).toMatchObject({ state: "done" });

    writeRecord(waiting, okRecord(B, { load_estimate: { weight_bytes: L - U + delta - GIB, kv_bytes_per_token: 0 } }));
    const epWaiting = await startBroker(waiting);
    const b = submit(epWaiting, B);
    await until("the load to wait on RAM", () => /waits for a load grant \(RAM: about \d+ MiB would not fit under ram_limit_pct now\)/.test(brokerLog(waiting)), 60_000, () => `waiting broker log tail:\n${logTail(waiting)}`);
    const unloaded = /stopped main llama-server .* \(the governor asked for its RAM back\)/;
    await until("both idle servers to give their RAM back", () => unloaded.test(brokerLog(old)) && unloaded.test(brokerLog(recent)), 60_000, () => `old broker log tail:\n${logTail(old)}\nrecent broker log tail:\n${logTail(recent)}`);
    // Least recently used first (D11).
    expect(loggedAt(old, unloaded)!).toBeLessThanOrEqual(loggedAt(recent, unloaded)!);
    expect(spawnCount(waiting)).toBe(0);

    // No flapping: a job for the unloaded model does not reload it inside the reload pause.
    const again = await submit(epOld, A);
    const pauseLeft = loggedAt(old, unloaded)! + reloadMs - Date.now();
    if (pauseLeft > 2_000) {
      await new Promise((r) => setTimeout(r, pauseLeft - 1_000));
      expect(spawnCount(old)).toBe(1);
    }
    expect(await outcome(epOld, again)).toMatchObject({ state: "done" });
    expect(spawnCount(old)).toBe(2);
    expect(spawnCount(waiting)).toBe(0);

    // A projection that fits now: the waiting load goes ahead, and its job completes.
    writeRecord(waiting, okRecord(B, { load_estimate: { weight_bytes: 1024 ** 2, kv_bytes_per_token: 0 } }));
    expect(await outcome(epWaiting, await b)).toMatchObject({ state: "done", status: 200 });
    expect(spawnCount(waiting)).toBe(1);
  }, TEST_MS);
});
