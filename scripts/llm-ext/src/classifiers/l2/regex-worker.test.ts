import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { MAX_CANDIDATE_CHARS, REGEX_TIMEOUT_MS, runRegex, runRegexLines, runRegexes } from "./regex-worker.js";
import type { SpawnWorker } from "./regex-worker.js";

// WHY the process report: it lists the live worker threads, so "no leaked thread" is asserted on the thread table, not inferred from vitest exiting.
const liveWorkers = (): number => (process.report.getReport() as unknown as { workers?: unknown[] }).workers?.length ?? 0;
// Handles owned by worker threads show up here under these names; counted before and after because the test runner may own some itself.
const workerHandles = (): number => process.getActiveResourcesInfo().filter((n) => /Worker|MessagePort/.test(n)).length;
const FAST = 100; // ms deadline used by every test except the one that pins the default

describe("runRegex: matches", () => {
  it("returns the whole match (group 0) even when the pattern has a capture group", async () => {
    expect(await runRegex("id=17 id=42", "id=(\\d+)", "", 20)).toEqual({ candidates: ["id=17", "id=42"], truncated: false, tooLong: 0, error: null });
  });
  it("deduplicates keeping first-occurrence order", async () => {
    expect((await runRegex("b a b c a", "[abc]", "", 20)).candidates).toEqual(["b", "a", "c"]);
  });
  it("drops empty matches and cannot loop on a pattern that matches empty", async () => {
    expect(await runRegex("ab", "x*", "", 20)).toEqual({ candidates: [], truncated: false, tooLong: 0, error: null });
    expect((await runRegex("a1b", "\\d*", "", 20)).candidates).toEqual(["1"]);
  });
  it("counts every match longer than the limit and skips it (a count, never a list)", async () => {
    const long = "y".repeat(MAX_CANDIDATE_CHARS + 1);
    expect(await runRegex(`${long} ${long} ok`, "y+|ok", "", 20)).toMatchObject({ candidates: ["ok"], tooLong: 2, truncated: false });
    expect((await runRegex("y".repeat(MAX_CANDIDATE_CHARS), "y+", "", 20)).candidates).toHaveLength(1);
  });
  it("the cap cuts and sets truncated only when one more eligible match exists", async () => {
    expect(await runRegex("a b c d", "[a-d]", "", 3)).toMatchObject({ candidates: ["a", "b", "c"], truncated: true });
    expect(await runRegex("a b c", "[a-c]", "", 3)).toMatchObject({ candidates: ["a", "b", "c"], truncated: false });
  });
  it("ineligible matches do not crowd out eligible ones under the cap", async () => {
    const long = "z".repeat(MAX_CANDIDATE_CHARS + 5);
    expect(await runRegex(`${long} a b`, "z+|[ab]", "", 2)).toMatchObject({ candidates: ["a", "b"], truncated: false, tooLong: 1 });
  });
  it("flags: multi-line and unicode work; g is forced exactly once; y is passed through (back-to-back from index 0)", async () => {
    expect((await runRegex("x\nab\nab", "^ab$", "m", 20)).candidates).toEqual(["ab"]);
    expect((await runRegex("a\u{1F600}b", "\\p{Emoji_Presentation}", "u", 20)).candidates).toEqual(["\u{1F600}"]);
    expect((await runRegex("Ab ab", "ab", "gi", 20)).candidates).toEqual(["Ab", "ab"]);
    expect((await runRegex("aab ab", "a", "y", 20)).candidates).toEqual(["a"]);
    expect((await runRegex("ba", "a", "y", 20)).candidates).toEqual([]);
  });
});

describe("runRegex: bounded work and memory", () => {
  it("a pattern that matches everywhere (. on 50000 chars, and an empty-capable one) returns at most cap candidates well inside the timeout", async () => {
    const text = Array.from({ length: 50_000 }, (_, i) => String.fromCharCode(0x4e00 + (i % 5000))).join("");
    const t0 = Date.now();
    const a = await runRegex(text, ".", "", 7, undefined, 5000);
    const b = await runRegex(text, "x*", "", 7, undefined, 5000);
    const c = await runRegex("a".repeat(50_000), ".", "", 7, undefined, 5000);
    expect(a).toMatchObject({ truncated: true, error: null });
    expect(a.candidates).toHaveLength(7);
    expect(b).toEqual({ candidates: [], truncated: false, tooLong: 0, error: null });
    expect(c.candidates).toEqual(["a"]);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("runRegex: errors are results, never throws", () => {
  it("a pattern that does not compile gives candidates [] and the engine's message", async () => {
    const r = await runRegex("abc", "(", "", 20);
    expect(r.candidates).toEqual([]);
    expect(r.error).toMatch(/Invalid regular expression/);
  });
  it("an invalid flag is an error result", async () => {
    const r = await runRegex("abc", "a", "z", 20);
    expect(r.candidates).toEqual([]);
    expect(r.error).toMatch(/flags/i);
  });
  it("a cap below 1, a fractional cap and a non-positive timeout are programming errors and throw", async () => {
    await expect(runRegex("a", "a", "", 0)).rejects.toThrow(/cap/);
    await expect(runRegex("a", "a", "", 1.5)).rejects.toThrow(/cap/);
    await expect(runRegex("a", "a", "", 2, undefined, 0)).rejects.toThrow(/timeout/);
  });
});

describe("SECURITY: pattern, flags and text are data, never source", () => {
  it("quotes, backticks, ${} and newlines in the pattern are a pattern (matches or a compile error), never executed", async () => {
    const pid = String(process.pid);
    const evil = ["`${process.exit(7)}`", "\"+process.exit(8)+\"", "');process.exit(9);//", "\n process.exit(10) \n", "\\$\\{process\\.pid\\}"];
    for (const p of evil) {
      const r = await runRegex("`${process.exit(7)}` \"+process.exit(8)+\" ');process.exit(9);// ${process.pid}", p, "", 20, undefined, 2000);
      expect(r.error === null || typeof r.error === "string").toBe(true);
      expect(r.candidates.every((c) => !c.includes(pid) || c.includes("${process.pid}"))).toBe(true);
    }
    expect((await runRegex("a ${process.pid} b", "\\$\\{process\\.pid\\}", "", 20)).candidates).toEqual(["${process.pid}"]);
  });
  it("quotes, backticks, ${} and newlines in the flags only reach the engine's flag check", async () => {
    for (const fl of ["`${process.exit(7)}`", "\"+process.exit(8)+\"", "i\nprocess.exit(9)"]) {
      const r = await runRegex("abc", "a", fl, 20, undefined, 2000);
      expect(r.error).toMatch(/flags/i);
    }
  });
});

describe("runRegexes: one worker, per-field deadline", () => {
  it("fields run in order in one call; a field that times out does not stop the next, which runs in a fresh worker", async () => {
    const hang = "a".repeat(40_000) + " end";
    const text = `${hang} 5 6`;
    const r = await runRegexes(text, [{ pattern: "\\d", flags: "" }, { pattern: "(a+)+$", flags: "" }, { pattern: "end", flags: "" }, { pattern: "(", flags: "" }], 20, { timeoutMs: FAST });
    expect(r.map((x) => x.error === null)).toEqual([true, false, true, false]);
    expect(r[0]!.candidates).toEqual(["5", "6"]);
    expect(r[1]!.error).toMatch(/timed out after 100ms/);
    expect(r[2]!.candidates).toEqual(["end"]);
    expect(r[3]!.error).toMatch(/Invalid regular expression/);
    expect(liveWorkers()).toBe(0);
  });
  it("an empty field list starts nothing", async () => {
    expect(await runRegexes("a", [], 5)).toEqual([]);
    expect(liveWorkers()).toBe(0);
  });
});

describe("runRegex: timeout and abort", () => {
  it("E64 (default deadline): (a+)+$ on 40000 a's + ' end' ends as a timeout error result, and the worker thread is gone afterwards", async () => {
    const before = workerHandles();
    expect(liveWorkers()).toBe(0);
    const t0 = Date.now();
    const r = await runRegex("a".repeat(40000) + " end", "(a+)+$", "", 20);
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ candidates: [], truncated: false, tooLong: 0 });
    expect(r.error).toBe(`regex timed out after ${REGEX_TIMEOUT_MS}ms`);
    expect(ms).toBeGreaterThanOrEqual(REGEX_TIMEOUT_MS - 50);
    expect(ms).toBeLessThan(REGEX_TIMEOUT_MS + 2000);
    // runRegexes awaits the worker's exit event before it resolves, so the thread table and the handle list are already clean here.
    expect(liveWorkers()).toBe(0);
    expect(workerHandles()).toBeLessThanOrEqual(before);
    console.log(`E64 elapsed ${ms} ms`);
  });
  it("a short deadline times out the same way and leaves no thread or handle", async () => {
    const before = workerHandles();
    const r = await runRegex("a".repeat(40000) + " end", "(a+)+$", "", 20, undefined, FAST);
    expect(r.error).toBe("regex timed out after 100ms");
    expect(liveWorkers()).toBe(0);
    expect(workerHandles()).toBeLessThanOrEqual(before);
  });
  it("an abort while the regex runs stops it at once and leaves no thread", async () => {
    const handlesBefore = workerHandles();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const t0 = Date.now();
    const r = await runRegex("a".repeat(40000) + " end", "(a+)+$", "", 20, ac.signal, 5000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ candidates: [], error: "aborted" });
    expect(workerHandles()).toBeLessThanOrEqual(handlesBefore);
    expect(liveWorkers()).toBe(0);
  });
  it("a signal already aborted starts no worker, and later fields of an aborted call are aborted too", async () => {
    expect(await runRegex("a", "a", "", 20, AbortSignal.abort())).toMatchObject({ candidates: [], error: "aborted" });
    expect(liveWorkers()).toBe(0);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const r = await runRegexes("a".repeat(40000) + " end", [{ pattern: "(a+)+$", flags: "" }, { pattern: "a", flags: "" }], 5, { signal: ac.signal, timeoutMs: 5000 });
    expect(r.map((x) => x.error)).toEqual(["aborted", "aborted"]);
    expect(liveWorkers()).toBe(0);
  });
});

describe("review round: worker lifecycle (spawn seam)", () => {
  const spawnReal = (list: Worker[], hook?: (w: Worker, n: number) => void): SpawnWorker => (source, options) => {
    const w = new Worker(source, options);
    list.push(w);
    hook?.(w, list.length);
    return w;
  };
  it("item 1: an error emitted after a run resolved is not an uncaught exception; the next field gets a fresh worker", async () => {
    const workers: Worker[] = [];
    // The hook's listener is registered before the run's own, so its microtask fires after the run settled and removed its listeners: exactly the window of a late heap-limit error.
    const spawn = spawnReal(workers, (w, n) => { if (n === 1) w.once("message", () => queueMicrotask(() => w.emit("error", new Error("late heap error")))); });
    const r = await runRegexes("a1 b2", [{ pattern: "[a-z]", flags: "" }, { pattern: "\\d", flags: "" }], 5, { spawn });
    expect(r.map((x) => x.candidates)).toEqual([["a", "b"], ["1", "2"]]);
    expect(workers).toHaveLength(2);
    expect(liveWorkers()).toBe(0);
  });
  it("item 3: a worker whose exit was seen between two fields is replaced, not waited on", async () => {
    const workers: Worker[] = [];
    const spawn = spawnReal(workers, (w, n) => { if (n === 1) w.once("message", () => queueMicrotask(() => w.emit("exit", 1))); });
    const t0 = Date.now();
    const r = await runRegexes("a1", [{ pattern: "[a-z]", flags: "" }, { pattern: "\\d", flags: "" }], 5, { spawn, timeoutMs: 5000 });
    expect(r.map((x) => x.candidates)).toEqual([["a"], ["1"]]);
    expect(workers).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(liveWorkers()).toBe(0);
  });
  it("item 3: a worker that dies during a run ends that field at once as an exit error (not a timeout); the next field is served by a fresh worker, results stay in field order", async () => {
    const workers: Worker[] = [];
    const spawn = spawnReal(workers, (w, n) => { if (n === 1) w.once("online", () => setTimeout(() => void w.terminate(), 20)); });
    const t0 = Date.now();
    const r = await runRegexes("a".repeat(40_000) + " end 7", [{ pattern: "(a+)+$", flags: "" }, { pattern: "\\d", flags: "" }], 5, { spawn, timeoutMs: 5000 });
    expect(r[0]!.error).toMatch(/exited/);
    expect(r[1]).toMatchObject({ candidates: ["7"], error: null });
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(workers).toHaveLength(2);
    expect(liveWorkers()).toBe(0);
  });
  it("item 2: a worker that never comes online ends as 'regex worker did not start' within the start-up deadline and is terminated", async () => {
    let terminated = 0;
    class Never extends EventEmitter {
      postMessage(): void {}
      terminate(): Promise<number> { terminated++; queueMicrotask(() => this.emit("exit", 1)); return Promise.resolve(1); }
    }
    const t0 = Date.now();
    const r = await runRegex("a", "a", "", 5, undefined, 5000, { spawn: () => new Never() as unknown as Worker, startupMs: 50 });
    expect(r).toMatchObject({ candidates: [], error: "regex worker did not start" });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(terminated).toBe(1);
  });
  it("item 10: a worker that cannot be constructed rejects the call (e.g. the permission model without worker permission)", async () => {
    await expect(runRegexes("a", [{ pattern: "a", flags: "" }], 5, { spawn: () => { throw new Error("worker denied"); } })).rejects.toThrow("worker denied");
  });
});

describe("review round: whole-call budget and flags", () => {
  it("item 4: once the call's total budget is spent the remaining fields get the budget error and never run", async () => {
    const hang = "a".repeat(40_000) + " end";
    const spawned: Worker[] = [];
    const t0 = Date.now();
    const r = await runRegexes(hang, Array.from({ length: 6 }, () => ({ pattern: "(a+)+$", flags: "" })), 5, { timeoutMs: 100, totalMs: 250, spawn: (s, o) => { const w = new Worker(s, o); spawned.push(w); return w; } });
    expect(r.filter((x) => /timed out/.test(x.error ?? "")).length).toBeGreaterThanOrEqual(2);
    expect(r.at(-1)!.error).toBe("regex budget for this call exhausted");
    expect(r.filter((x) => x.error === "regex budget for this call exhausted").length).toBeGreaterThanOrEqual(2);
    expect(spawned.length).toBeLessThan(6);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(liveWorkers()).toBe(0);
  });
  it("item 4: the default budget is min(fields x timeout, 5000 ms): a normal call never trips it", async () => {
    const r = await runRegexes("a1 b2", Array.from({ length: 32 }, () => ({ pattern: "\\d", flags: "" })), 5);
    expect(r.every((x) => x.error === null)).toBe(true);
  });
  it("item 5: flags with anything but letters are an error result (not cleaned) and start no worker; an unknown letter stays the engine's error", async () => {
    let spawns = 0;
    const spawn: SpawnWorker = (s, o) => { spawns++; return new Worker(s, o); };
    for (const fl of ["i1", "g,i", " i", "i\n", "`${x}`"]) {
      const r = await runRegex("abc", "a", fl, 5, undefined, undefined, { spawn });
      expect(r.candidates).toEqual([]);
      expect(r.error).toMatch(/^invalid flags: /);
    }
    expect(spawns).toBe(0);
    expect((await runRegex("abc", "a", "z", 5)).error).toMatch(/flags/i);
  });
  it("cap boundary: exactly cap eligible matches is not truncated, cap + 1 is", async () => {
    expect(await runRegex("a b c", "[a-c]", "", 3)).toMatchObject({ truncated: false });
    expect(await runRegex("a b c d", "[a-d]", "", 3)).toMatchObject({ truncated: true });
  });
});
describe("speed (measured, logged)", () => {
  it("5 trivial fields on a 50000-character document in one call", async () => {
    const text = "word 12 ".repeat(6250);
    const handlesBefore = workerHandles();
    const t0 = performance.now();
    const r = await runRegexes(text, Array.from({ length: 5 }, () => ({ pattern: "\\d+", flags: "" })), 20);
    const ms = performance.now() - t0;
    expect(r.every((x) => x.error === null && x.candidates[0] === "12")).toBe(true);
    // A normal run leaves no thread or handle either.
    expect(liveWorkers()).toBe(0);
    expect(workerHandles()).toBeLessThanOrEqual(handlesBefore);
    const t1 = performance.now();
    await runRegex("a", "a", "", 5);
    console.log(`5 fields on 50000 chars: ${ms.toFixed(1)} ms; one trivial call (thread start + stop): ${(performance.now() - t1).toFixed(1)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});


// Line-index mode (Z55FYUQH): real worker threads only, no spawn seam.
describe("runRegexLines: 1-based ascending line numbers", () => {
  it("reports the matching lines 1-based and ascending over the whole text", async () => {
    const r = await runRegexLines("ok\nFAIL a\nok\nFAIL b\nFAIL c", "FAIL", "", 20, undefined, 5000);
    expect(r).toMatchObject({ lines: [2, 4, 5], truncated: false, tooLong: 0, error: null });
  });
  it("no match gives an empty list, not an error", async () => {
    expect(await runRegexLines("a\nb", "zzz", "", 20, undefined, 5000)).toMatchObject({ lines: [], error: null });
  });
  it("a sticky or case-insensitive flag does not skip or repeat lines (lastIndex is reset per line)", async () => {
    expect((await runRegexLines("a\nA\na", "a", "i", 20, undefined, 5000)).lines).toEqual([1, 2, 3]);
    expect((await runRegexLines("a\na\nba", "a", "y", 20, undefined, 5000)).lines).toEqual([1, 2]);
  });
  it("CRLF text gives the same numbers as LF, and a final newline adds no line", async () => {
    const lf = "x\nFAIL\ny\nFAIL\n";
    expect((await runRegexLines(lf.replace(/\n/g, "\r\n"), "^FAIL$", "", 20, undefined, 5000)).lines).toEqual([2, 4]);
    expect((await runRegexLines(lf, "^FAIL$", "", 20, undefined, 5000)).lines).toEqual([2, 4]);
    expect((await runRegexLines("a\n\n", "^$", "", 20, undefined, 5000)).lines).toEqual([2]);
  });
  it("the cap cuts the list and sets truncated; a line over the candidate limit is cut before the test and counted", async () => {
    expect(await runRegexLines("a\na\na", "a", "", 2, undefined, 5000)).toMatchObject({ lines: [1, 2], truncated: true });
    const r = await runRegexLines(`${"y".repeat(MAX_CANDIDATE_CHARS)}FAIL\nFAIL`, "FAIL", "", 20, undefined, 5000);
    expect(r).toMatchObject({ lines: [2], tooLong: 1 });
  });
  it("a bad pattern is an error result without lines", async () => {
    const r = await runRegexLines("a", "(", "", 20, undefined, 5000);
    expect(r.error).toMatch(/Invalid regular expression/);
    expect(r.lines).toBeUndefined();
  });
  it("a catastrophic pattern times out with the same error class as string mode, and the thread is gone", async () => {
    const text = "a".repeat(30) + "!";
    const s = await runRegex(text, "(a+)+$", "", 20, undefined, FAST);
    const r = await runRegexLines(text, "(a+)+$", "", 20, undefined, FAST);
    expect(s.error).toMatch(/timed out/);
    expect(r.error).toMatch(/timed out/);
    expect(liveWorkers()).toBe(0);
  });
  it("an abort mid-run ends as the error result aborted, as string mode does, leaving no thread", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const r = await runRegexLines("a".repeat(30) + "!", "(a+)+$", "", 20, ac.signal, 5000);
    expect(r.error).toBe("aborted");
    expect(liveWorkers()).toBe(0);
  });
});

// needs esbuild (a devDependency), not dist/: bundles this module the way esbuild.config.mjs bundles the CLI (one ESM file, node builtins external) and runs the bundle,
// proving the inline worker source needs no neighbouring file. A check against dist/llm-ext.js itself is only possible once the command layer calls the worker (see the report).
describe("needs build: the inline worker survives bundling", () => {
  it("a bundled copy of regex-worker.ts, run from an unrelated directory, still times out a catastrophic regex and finds matches", async () => {
    const dir = mkdtempSync(join("/tmp", "llm-ext-sp22-"));
    try {
      const out = join(dir, "bundle.mjs");
      await build({ entryPoints: [new URL("./regex-worker.ts", import.meta.url).pathname], bundle: true, platform: "node", target: "node18", format: "esm", outfile: out, external: ["node:*"], logLevel: "silent" });
      writeFileSync(join(dir, "package.json"), "{}");
      const m = (await import(pathToFileURL(out).href)) as typeof import("./regex-worker.js");
      expect((await m.runRegex("a1 b2", "[a-z]\\d", "", 5)).candidates).toEqual(["a1", "b2"]);
      expect((await m.runRegex("a".repeat(40000) + " end", "(a+)+$", "", 5, undefined, FAST)).error).toMatch(/timed out/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
