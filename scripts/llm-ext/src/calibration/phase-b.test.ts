// P6b: Phase B (spec 4.3) and the window estimate (spec 4.1), pure parts.
// Degenerate answerers (spec section 9, coordinator decision 16) must FAIL the
// step they target at every grid step, through the real sequential rule; a
// reply cut at max_tokens is inconclusive, never a fail.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUG_CORPUS, BUG_CORPUS_SHA256 } from "./bug-corpus.js";
import { BUG_PLANTS, plantLines } from "./bug-plants.js";
import { chooseWindow, configKvLayers, ggufKvLayers, kvBytes, readGgufMetadata, WINDOW_HEADROOM_BYTES } from "./memory.js";
import { CAP_OFF, CAP_ON, type Outcome, type Reply } from "./phase-a.js";
import {
  aggregateCountOutcome,
  aggregateDocument,
  aggregateIsCount,
  aggregateListOutcome,
  bugDocument,
  bugOutcome,
  factDocument,
  factOutcome,
  gridSteps,
  listedNames,
  NEEDLE_POSITIONS,
  outputFloor,
  parseBugAnswer,
  seedOf,
  sequentialVerdict,
  variantSeed,
  cutOutcome,
  transportVerdict,
  walkGrid,
  stepFit,
  windowTooSmallReason,
  windowResume,
} from "./phase-b-fixtures.js";
import { measureWindow } from "./phase-b.js";
import { writeGguf } from "./gguf-fixture.js";
import type { PhaseContext } from "./runner.js";
import type { TrialRecord } from "./state.js";

const reply = (content: string, o: Partial<Reply> = {}): Reply => ({
  status: 200,
  content,
  reasoning: "",
  finishReason: "stop",
  promptTokens: 30,
  completionTokens: 5,
  timedOut: false,
  wallMs: 100,
  ...o,
});

/** The production grid at W = 32768, as characters (about 3.5 per token). */
const STEPS = gridSteps(32768, null);
const charsOf = (tokens: number): number => Math.round(tokens * 3.5);

/** Run a counter to its verdict with `outcome(i)` as trial i's result (the phase's own loop, without a model). */
function verdictOf(outcome: (i: number) => Outcome, t = 5): "pass" | "fail" {
  const outs: Outcome[] = [];
  for (;;) {
    const v = sequentialVerdict(outs, t);
    if (v !== "more") return v;
    outs.push(outcome(outs.length));
  }
}

const factStep = (tokens: number, answer: (doc: ReturnType<typeof factDocument>, q: number) => string): "pass" | "fail" => {
  const seed = seedOf("fact", tokens);
  return verdictOf((i) => {
    const doc = factDocument(seedOf(seed, Math.floor(i / 5)), charsOf(tokens));
    const q = i % 5;
    return factOutcome(reply(answer(doc, q)), doc.needles[q].code, [...doc.needles, ...doc.decoys].map((x) => x.code));
  });
};

const aggregateStep = (tokens: number, answer: (doc: ReturnType<typeof aggregateDocument>, count: boolean) => string): "pass" | "fail" => {
  const seed = seedOf("aggregate", tokens);
  return verdictOf((i) => {
    const doc = aggregateDocument(seed, i, charsOf(tokens));
    const count = aggregateIsCount(i);
    const r = reply(answer(doc, count));
    return count ? aggregateCountOutcome(r, doc.vaults.length) : aggregateListOutcome(r, doc.vaults);
  });
};

/** A bug step: both counters must pass (spec 4.3). */
const bugStep = (tokens: number, answer: (doc: ReturnType<typeof bugDocument>) => string): "pass" | "fail" => {
  const seed = seedOf("bug", tokens);
  const counter = (buggy: boolean): "pass" | "fail" =>
    verdictOf((i) => {
      const doc = bugDocument(seed, i, charsOf(tokens), buggy);
      return bugOutcome(reply(answer(doc)), doc);
    });
  return counter(true) === "pass" && counter(false) === "pass" ? "pass" : "fail";
};

const plantOf = (doc: { path: string }) => {
  const p = BUG_PLANTS.find((x) => x.path === doc.path);
  if (!p) throw new Error(`no plant ${doc.path}`);
  return p;
};

describe("Phase B: real answers pass every step", () => {
  it.each(STEPS)("fact, aggregate and bug at %i tokens", (tokens) => {
    expect(factStep(tokens, (doc, q) => doc.needles[q].code)).toBe("pass");
    expect(aggregateStep(tokens, (doc, count) => (count ? `There are ${doc.vaults.length} vaults.` : doc.vaults.map((v) => `vault ${v}`).join(", ")))).toBe("pass");
    expect(bugStep(tokens, (doc) => JSON.stringify(doc.line === null ? { file: null, line: null } : { file: doc.path, line: doc.line + 1 }))).toBe("pass");
  });
});

describe("Phase B: degenerate answerers fail every step (spec 9)", () => {
  it.each(STEPS)("fact at %i tokens: every code, a decoy code, the first needle's code, an empty answer", (tokens) => {
    expect(factStep(tokens, (doc) => [...doc.needles, ...doc.decoys].map((x) => x.code).join(" "))).toBe("fail");
    expect(factStep(tokens, (doc) => doc.decoys[0].code)).toBe("fail");
    expect(factStep(tokens, (doc) => doc.needles[0].code)).toBe("fail");
    expect(factStep(tokens, () => "")).toBe("fail");
  });
  it.each(STEPS)("aggregate at %i tokens: always 5, and the list of every capitalised word", (tokens) => {
    expect(aggregateStep(tokens, () => "5")).toBe("fail");
    expect(aggregateStep(tokens, (doc) => [...new Set(doc.text.match(/\b[A-Z][a-z]+\b/g) ?? [])].join(", "))).toBe("fail");
  });
  it.each(STEPS)("bug at %i tokens: always null, the planted function's first line, the file's last line, one fixed real corpus line", (tokens) => {
    const nul = JSON.stringify({ file: null, line: null });
    expect(bugStep(tokens, () => nul)).toBe("fail");
    expect(bugStep(tokens, (doc) => JSON.stringify({ file: doc.path, line: 1 }))).toBe("fail");
    expect(bugStep(tokens, (doc) => JSON.stringify({ file: doc.path, line: plantOf(doc).code.length }))).toBe("fail");
    expect(bugStep(tokens, () => JSON.stringify({ file: BUG_CORPUS[0].path, line: 10 }))).toBe("fail");
  });
  it("always null passes every control and fails every bug trial, so the bug step fails on the bug counter alone", () => {
    const seed = seedOf("bug", 4096);
    for (let i = 0; i < 10; i++) {
      expect(bugOutcome(reply('{"file": null, "line": null}'), bugDocument(seed, i, charsOf(4096), false))).toBe("pass");
      expect(bugOutcome(reply('{"file": null, "line": null}'), bugDocument(seed, i, charsOf(4096), true))).toBe("fail");
    }
  });
});

describe("Phase B scorers", () => {
  it("fact: the code alone, in a sentence, in lower case or after a think block passes; another vault's code beside it fails", () => {
    const all = ["ABCD2345", "WXYZ6789"];
    expect(factOutcome(reply("ABCD2345"), "ABCD2345", all)).toBe("pass");
    expect(factOutcome(reply("The code is abcd2345."), "ABCD2345", all)).toBe("pass");
    expect(factOutcome(reply("<think>WXYZ6789?</think>ABCD2345"), "ABCD2345", all)).toBe("pass");
    expect(factOutcome(reply("ABCD2345 or WXYZ6789"), "ABCD2345", all)).toBe("fail");
    expect(factOutcome(reply("XABCD2345"), "ABCD2345", all)).toBe("fail");
  });
  it("aggregate count: digits or a number word; a second, different number fails", () => {
    expect(aggregateCountOutcome(reply("7"), 7)).toBe("pass");
    expect(aggregateCountOutcome(reply("Seven vaults."), 7)).toBe("pass");
    expect(aggregateCountOutcome(reply("7 or 8"), 7)).toBe("fail");
    expect(aggregateCountOutcome(reply("several"), 7)).toBe("fail");
  });
  it("aggregate list: commas, 'and', bullets and the word vault are handled; a missing or extra name fails", () => {
    expect(listedNames("- Vault Harlow\n- Brindle and corvin.")).toEqual(["harlow", "brindle", "corvin"]);
    expect(aggregateListOutcome(reply("Harlow, Brindle and Corvin"), ["Corvin", "Harlow", "Brindle"])).toBe("pass");
    expect(aggregateListOutcome(reply("Harlow, Brindle"), ["Corvin", "Harlow", "Brindle"])).toBe("fail");
    expect(aggregateListOutcome(reply("Harlow, Brindle, Corvin, Elwick"), ["Corvin", "Harlow", "Brindle"])).toBe("fail");
  });
  it("bug: the right file within 1 line passes; 2 lines off, another file, prose or a broken object fails; the control wants null for both", () => {
    const exp = { path: "src/a.ts", line: 10 };
    expect(bugOutcome(reply('{"file": "src/a.ts", "line": 11}'), exp)).toBe("pass");
    expect(bugOutcome(reply('Found it: {"file": "./src/a.ts", "line": "9"}'), exp)).toBe("pass");
    expect(bugOutcome(reply('```json\n{"file": "src/a.ts", "line": 10}\n```'), exp)).toBe("pass");
    expect(bugOutcome(reply('{"file": "src/a.ts", "line": 12}'), exp)).toBe("fail");
    expect(bugOutcome(reply('{"file": "src/b.ts", "line": 10}'), exp)).toBe("fail");
    expect(bugOutcome(reply("line 10 of src/a.ts"), exp)).toBe("fail");
    expect(bugOutcome(reply('{"file": "src/a.ts"}'), exp)).toBe("fail");
    expect(bugOutcome(reply('{"file": null, "line": null}'), { path: "src/a.ts", line: null })).toBe("pass");
    expect(bugOutcome(reply('{"file": "src/a.ts", "line": null}'), { path: "src/a.ts", line: null })).toBe("fail");
    expect(parseBugAnswer('<think>{"file": "x", "line": 1}</think>{"file": null, "line": null}')).toEqual({ file: null, line: null });
  });
  it("a reply cut at max_tokens or by the timeout is inconclusive for every Phase B scorer, never a fail", () => {
    for (const r of [reply("", { finishReason: "length" }), reply("", { status: 0, timedOut: true, finishReason: null })]) {
      expect(factOutcome(r, "ABCD2345", ["ABCD2345"])).toBe("inconclusive");
      expect(aggregateCountOutcome(r, 3)).toBe("inconclusive");
      expect(aggregateListOutcome(r, ["A"])).toBe("inconclusive");
      expect(bugOutcome(r, { path: "a", line: 3 })).toBe("inconclusive");
      expect(bugOutcome(r, { path: "a", line: null })).toBe("inconclusive");
    }
  });
});

describe("Phase B fixtures", () => {
  it("are deterministic: the same seed rebuilds the same text; another seed does not", () => {
    expect(factDocument(7, 9000)).toEqual(factDocument(7, 9000));
    expect(factDocument(7, 9000).text).not.toBe(factDocument(8, 9000).text);
    expect(aggregateDocument(3, 4, 9000)).toEqual(aggregateDocument(3, 4, 9000));
    expect(bugDocument(5, 2, 20000, true)).toEqual(bugDocument(5, 2, 20000, true));
  });
  it("a rerun (variant 1, 2) gets a new document of the same kind: the same vault count, the same planted function, other text", () => {
    const seed = seedOf("aggregate", 4096);
    expect(aggregateDocument(seed, 3, 9000, 1).vaults).toHaveLength(aggregateDocument(seed, 3, 9000, 0).vaults.length);
    expect(aggregateDocument(seed, 3, 9000, 1).text).not.toBe(aggregateDocument(seed, 3, 9000, 0).text);
    const b0 = bugDocument(seed, 3, 20000, true, 0);
    const b1 = bugDocument(seed, 3, 20000, true, 1);
    expect([b1.path, b1.line]).toEqual([b0.path, b0.line]);
    expect(b1.text).not.toBe(b0.text);
    expect(variantSeed(seed, 3, 0)).toBe(seedOf(seed, 3));
    expect(variantSeed(seed, 3, 1)).not.toBe(variantSeed(seed, 3, 2));
  });
  it("fact: 5 needles in order at 5-95 %, 3 decoys, 8 distinct codes, and 'vault' only in the planted sentences", () => {
    const doc = factDocument(11, 40000);
    expect(doc.needles.map((n) => n.at)).toEqual([...NEEDLE_POSITIONS]);
    const codes = [...doc.needles, ...doc.decoys].map((x) => x.code);
    expect(new Set(codes).size).toBe(8);
    expect(doc.text.match(/\bvault\b/g)?.length).toBe(8);
    const at = doc.needles.map((n) => doc.text.indexOf(n.code) / doc.text.length);
    at.forEach((p, i) => expect(Math.abs(p - NEEDLE_POSITIONS[i])).toBeLessThan(0.03));
    expect(Math.abs(doc.text.length - 40000)).toBeLessThan(400);
  });
  it("aggregate: 3 to 9 vaults; the count never repeats within 7 consecutive count trials", () => {
    const seed = seedOf("aggregate", 2048);
    const counts = Array.from({ length: 14 }, (_, k) => aggregateDocument(seed, 2 * k, 5000).vaults.length);
    expect(counts.every((n) => n >= 3 && n <= 9)).toBe(true);
    expect(new Set(counts.slice(0, 7)).size).toBe(7);
    expect(new Set(counts.slice(7, 14)).size).toBe(7);
  });
  it("bug: the plant and its control twin differ in exactly the bug line, shown numbered, and the document is near its size", () => {
    const b = bugDocument(9, 1, 30000, true);
    const c = bugDocument(9, 1, 30000, false);
    const diff = b.text.split("\n").filter((l, i) => l !== c.text.split("\n")[i]);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatch(new RegExp(`^\\s*${b.line}\\| `));
    expect(b.text).toContain(`=== ${b.path} ===`);
    expect(c.line).toBeNull();
    expect(Math.abs(b.text.length - 30000)).toBeLessThan(1500);
  });
  it("every plant: exactly one line changes, never the first two or the last two lines of its file", () => {
    expect(BUG_PLANTS).toHaveLength(20);
    expect(new Set(BUG_PLANTS.map((p) => p.path)).size).toBe(20);
    for (const p of BUG_PLANTS) {
      const good = plantLines(p, false);
      const bad = plantLines(p, true);
      expect(bad.filter((l, i) => l !== good[i])).toHaveLength(1);
      expect(p.bug.line).toBeGreaterThanOrEqual(3);
      expect(p.bug.line).toBeLessThanOrEqual(good.length - 2);
    }
  });
  it("the bug corpus is pinned: a change must bump FIXTURE_VERSION and BUG_CORPUS_SHA256 together", () => {
    const h = createHash("sha256");
    for (const f of BUG_CORPUS) h.update(`${f.path}\u0000${f.text}\u0000`);
    expect(h.digest("hex")).toBe(BUG_CORPUS_SHA256);
    expect(BUG_CORPUS.some((f) => BUG_PLANTS.some((p) => p.path === f.path))).toBe(false);
  });
});

/**
 * Trial i of a counter as the phase runs it under D1: each attempt gets a reply; a reply cut at the cap
 * (finish "length") is rerun on a new document once, and a second cut is a fail. `replyFor(i, attempt)` plays the model.
 */
function trialWithCuts(i: number, replyFor: (i: number, attempt: number) => Reply, score: (r: Reply) => Outcome): Outcome {
  let cuts = 0;
  for (;;) {
    const r = replyFor(i, cuts);
    if (r.finishReason !== "length") return score(r);
    const o = cutOutcome(cuts++);
    if (o !== "inconclusive") return o;
  }
}

describe("D1: a reply cut at max_tokens (main-agent decision 2026-10-29)", () => {
  it("is rerun once, then a fail; the scorers alone still call it not scored", () => {
    expect(cutOutcome(0)).toBe("inconclusive");
    expect(cutOutcome(1)).toBe("fail");
    expect(factOutcome(reply("ABCD", { finishReason: "length" }), "ABCD2345", ["ABCD2345"])).toBe("inconclusive");
  });
});

/**
 * The walk of one kind as Phase B runs it (main-agent decision 2026-10-29, amended after review): each step is checked
 * with stepFit when it runs; "skip" counts as not fitting, "wait" stops the walk (the model waits for memory), and a
 * step that runs passes when `passes(tokens)` says so. Returns the fill and what happened at each step.
 */
async function walkKind(steps: readonly number[], cap: number, hard: number, soft: number, passes: (tokens: number) => boolean): Promise<{ fill: number; log: string[] } | "wait"> {
  const log: string[] = [];
  try {
    const fill = await walkGrid(steps, async (tokens) => {
      const fit = stepFit(tokens, cap, hard, soft);
      log.push(`${tokens}:${fit}`);
      if (fit === "wait") throw new Error("wait");
      return fit === "run" && passes(tokens);
    });
    return { fill, log };
  } catch {
    return "wait";
  }
}

describe("grid steps and the window (main-agent decision 2026-10-29, amended after review; the user may override)", () => {
  it("W 10303: no step fits thinking-on output, bug is window-limited (unfit); W 10304 runs bug at 2048; fact and aggregate run at both", async () => {
    expect(await walkKind([4096, 2048], CAP_ON, 10303, 10303, () => true)).toEqual({ fill: 0, log: ["4096:skip", "2048:skip"] });
    expect(await walkKind([4096, 2048], CAP_ON, 10304, 10304, () => true)).toEqual({ fill: 2048, log: ["4096:skip", "2048:run"] });
    for (const W of [10303, 10304]) expect(await walkKind([4096, 2048], CAP_OFF, W, W, () => true)).toEqual({ fill: 4096, log: ["4096:run"] });
    expect(windowTooSmallReason(10303, "on")).toBe("window 10303 too small for thinking on output");
  });
  it("the 0.4 x W top step: bug skips it while top + 8192 + 64 > W and runs it from the first W where it fits; fact and aggregate run it at both", async () => {
    // gridSteps floors 0.4 x W, so the boundary is W 13758 (top 5503, needs 13759) / W 13759 (top 5503, needs 13759),
    // one token below the 13759 / 13760 the exact 0.4 x W would give.
    const at = (W: number) => gridSteps(W, null);
    expect(at(13758)[0]).toBe(5503);
    expect(await walkKind(at(13758), CAP_ON, 13758, 13758, () => true)).toEqual({ fill: 4096, log: ["5503:skip", "4096:run"] });
    expect(await walkKind(at(13759), CAP_ON, 13759, 13759, () => true)).toEqual({ fill: 5503, log: ["5503:run"] });
    expect(at(13760)[0]).toBe(5504);
    expect(await walkKind(at(13760), CAP_ON, 13760, 13760, () => true)).toEqual({ fill: 5504, log: ["5504:run"] });
    for (const W of [13758, 13759, 13760]) expect((await walkKind(at(W), CAP_OFF, W, W, () => true)) as { fill: number }).toMatchObject({ fill: at(W)[0] });
  });
  it("bug with broken thinking-on runs thinking off: the 2048 cap, floor 4160", async () => {
    expect(await walkKind([2048], CAP_OFF, 4159, 4159, () => true)).toEqual({ fill: 0, log: ["2048:skip"] });
    expect(await walkKind([2048], CAP_OFF, 4160, 4160, () => true)).toEqual({ fill: 2048, log: ["2048:run"] });
  });
  it("a soft-W shortfall (fits total RAM, not the free memory now) waits, never skips, never gives unfit", async () => {
    expect(stepFit(4096, CAP_ON, 32768, 10304)).toBe("wait");
    expect(stepFit(2048, CAP_ON, 32768, 10304)).toBe("run");
    expect(stepFit(2048, CAP_ON, 10304, 4096)).toBe("wait");
    expect(await walkKind([4096, 2048], CAP_ON, 32768, 10304, () => true)).toBe("wait");
    expect(await walkKind([2048], CAP_ON, 10304, 8000, () => true)).toBe("wait");
  });
  it("a step that does not fit the hard W is skipped whatever the soft W says", () => {
    expect(stepFit(4096, CAP_ON, 12351, 32768)).toBe("skip");
    expect(stepFit(4096, CAP_ON, 12352, 12352)).toBe("run");
  });
});

describe("D1 grid walk with cap cuts (main-agent decision 2026-10-29)", () => {
  it("a cap cut at the top step with a pass at a lower step gives fill_tokens = the lower step", async () => {
    const steps = gridSteps(32768, null);
    const fill = await walkGrid(steps, async (tokens) =>
      verdictOf((i) =>
        trialWithCuts(i, () => (tokens > 4096 ? reply("rambling…", { finishReason: "length" }) : reply("7")), (r) => aggregateCountOutcome(r, 7)),
      ) === "pass",
    );
    expect(fill).toBe(4096);
  });
  it("a cap cut at every step gives 0 (unfit), never a failed model", async () => {
    const tried: number[] = [];
    const fill = await walkGrid(gridSteps(32768, null), async (tokens) => {
      tried.push(tokens);
      return verdictOf((i) => trialWithCuts(i, () => reply("", { finishReason: "length" }), (r) => aggregateCountOutcome(r, 7))) === "pass";
    });
    expect(fill).toBe(0);
    expect(tried).toEqual([13107, 8192, 4096, 2048]);
  });
  it("one cut then a good answer on the rerun document counts as that answer", () => {
    expect(trialWithCuts(0, (_i, a) => (a === 0 ? reply("", { finishReason: "length" }) : reply("7")), (r) => aggregateCountOutcome(r, 7))).toBe("pass");
  });
});

describe("D3: a failed request (main-agent decision 2026-10-29)", () => {
  it("the same server still alive: a network error or a timeout is inconclusive; a dead or replaced server is a crash; a reply is scored", () => {
    expect(transportVerdict({ status: 0, timedOut: false }, true)).toBe("inconclusive");
    expect(transportVerdict({ status: 0, timedOut: true }, true)).toBe("inconclusive");
    expect(transportVerdict({ status: 0, timedOut: false }, false)).toBe("crash");
    expect(transportVerdict({ status: 200, timedOut: false }, false)).toBe("crash");
    expect(transportVerdict({ status: 200, timedOut: false }, true)).toBe("score");
    expect(transportVerdict({ status: 400, timedOut: false }, true)).toBe("score");
  });
});

describe("Phase B rules", () => {
  const o = (s: string): Outcome[] => [...s].map((c) => (c === "p" ? "pass" : "fail"));
  it("the sequential rule: 5/5 passes, 2 or fewer of 5 fails, 3 or 4 adds 5 more and passes at 8 of 10", () => {
    expect(sequentialVerdict(o("ppppp"), 5)).toBe("pass");
    expect(sequentialVerdict(o("ppfff"), 5)).toBe("fail");
    expect(sequentialVerdict(o("pppff"), 5)).toBe("more");
    expect(sequentialVerdict(o("ppppf"), 5)).toBe("more");
    expect(sequentialVerdict(o("pppffppppp"), 5)).toBe("pass");
    expect(sequentialVerdict(o("ppppfppppf"), 5)).toBe("pass");
    expect(sequentialVerdict(o("pppffpppfp"), 5)).toBe("fail");
    // A certain verdict is returned early.
    expect(sequentialVerdict(o("fff"), 5)).toBe("fail");
    expect(sequentialVerdict(o("pppffpppp"), 5)).toBe("more");
    expect(sequentialVerdict(o("ppppfpppp"), 5)).toBe("pass");
    expect(sequentialVerdict(o("pppfff"), 5)).toBe("fail");
    expect(sequentialVerdict([], 5)).toBe("more");
  });
  it("the grid: 2048, 4096, 8192 and 0.40 x W, none above 0.40 x W, largest first; a reduced harness keeps its steps", () => {
    expect(gridSteps(32768, null)).toEqual([13107, 8192, 4096, 2048]);
    expect(gridSteps(16384, null)).toEqual([6553, 4096, 2048]);
    expect(gridSteps(5120, null)).toEqual([2048]);
    expect(gridSteps(4096, [1024, 2048])).toEqual([2048, 1024]);
  });
  it("output floors: the largest passing completion x 1.25, up to a multiple of 256; none = 0", () => {
    expect(outputFloor([100, 300])).toBe(512);
    expect(outputFloor([1024])).toBe(1280);
    expect(outputFloor([])).toBe(0);
  });
});

describe("the window estimate (spec 4.1)", () => {
  it("reads GGUF metadata: per-layer KV heads (0 = a layer without KV), and a per-layer sliding-window pattern", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-ext-gguf-"));
    try {
      const f = join(dir, "m.gguf");
      writeGguf(f, [
        ["general.architecture", "lfm3"],
        ["lfm3.block_count", 4],
        ["lfm3.attention.head_count", 8],
        ["lfm3.embedding_length", 512],
        ["lfm3.attention.head_count_kv", [0, 2, 0, 2]],
        ["lfm3.attention.sliding_window", 256],
        ["lfm3.attention.sliding_window_pattern", [false, true, false, false]],
        ["tokenizer.ggml.tokens.count", 7],
      ]);
      const layers = ggufKvLayers(readGgufMetadata(f));
      // head size 512 / 8 = 64: K + V = 2 x 2 x 64 = 256 elements per KV layer.
      expect(layers).toEqual([
        { kvElems: 0, window: 0 },
        { kvElems: 256, window: 256 },
        { kvElems: 0, window: 0 },
        { kvElems: 256, window: 0 },
      ]);
      // 4096 tokens: the sliding layer holds 256 of them, the full layer all; 2 bytes per element.
      expect(kvBytes(layers, 4096)).toBe(256 * 2 * 256 + 256 * 2 * 4096);
      writeFileSync(join(dir, "bad.gguf"), "NOPE");
      expect(() => readGgufMetadata(join(dir, "bad.gguf"))).toThrow(/not a GGUF|ends early/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  it("a hybrid model counts only every n-th layer (plus its MTP layers); a looped model counts each pass; unknown layouts count every layer", () => {
    const m = (kv: Record<string, unknown>) => new Map(Object.entries({ "general.architecture": "x", "x.block_count": 9, "x.attention.head_count": 4, "x.attention.head_count_kv": 2, "x.attention.key_length": 64, "x.attention.value_length": 64, ...kv }) as Array<[string, never]>);
    expect(ggufKvLayers(m({ "x.full_attention_interval": 4, "x.nextn_predict_layers": 1 })).map((l) => l.kvElems > 0)).toEqual([false, false, false, true, false, false, false, true, true]);
    expect(ggufKvLayers(m({ "x.num_loops": 2 }))[0].kvElems).toBe(2 * 2 * 128);
    expect(ggufKvLayers(m({ "x.attention.sliding_window": 128 })).every((l) => l.window === 0 && l.kvElems === 256)).toBe(true);
    expect(ggufKvLayers(m({ "x.attention.sliding_window": 128, "x.attention.sliding_window_pattern": 3 })).map((l) => l.window)).toEqual([128, 128, 0, 128, 128, 0, 128, 128, 0]);
  });
  it("reads config.json: layer_types (conv and linear layers hold no KV), full_attention_interval, text_config, num_loops", () => {
    const lfm = configKvLayers({ num_hidden_layers: 3, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 64, sliding_window: 256, layer_types: ["conv", "sliding_attention", "full_attention"] });
    expect(lfm).toEqual([
      { kvElems: 0, window: 0 },
      { kvElems: 256, window: 256 },
      { kvElems: 256, window: 0 },
    ]);
    const qwen = configKvLayers({ text_config: { num_hidden_layers: 8, num_attention_heads: 8, num_key_value_heads: 2, head_dim: 64, full_attention_interval: 4 } });
    expect(qwen.filter((l) => l.kvElems > 0)).toHaveLength(2);
    expect(configKvLayers({ num_hidden_layers: 2, hidden_size: 512, num_attention_heads: 8, num_key_value_heads: 2, num_loops: 2 })[0].kvElems).toBe(2 * 2 * 2 * 64);
    expect(() => configKvLayers({ num_hidden_layers: 2 })).toThrow(/head size/);
  });
  it("W is the largest multiple of 256 with weights + KV + 1 GB under the budget, at most the cap", () => {
    const layers = [{ kvElems: 1024, window: 0 }]; // 2048 bytes per token
    const weights = 2 * 1024 ** 3;
    const budget = weights + WINDOW_HEADROOM_BYTES + 2048 * 10_000;
    expect(chooseWindow(layers, weights, budget, 32768)).toBe(9984);
    expect(chooseWindow(layers, weights, budget, 4096)).toBe(4096);
    expect(chooseWindow(layers, weights, weights, 32768)).toBe(0);
  });
});

describe("a resume keeps Phase B while the hard W is the same (main-agent decision 2026-10-29; the user may override)", () => {
  it("windowResume: fresh without an earlier hard W, keep when it is the same, restart only when it changed", () => {
    expect(windowResume(null, 32768)).toBe("fresh");
    expect(windowResume(32768, 32768)).toBe("keep");
    expect(windowResume(16384, 32768)).toBe("restart");
  });
  /** A Phase B context over a real (synthetic) GGUF and the real free memory; no server, no model. */
  const ctxOver = (file: string, trials: TrialRecord[]): PhaseContext =>
    ({
      item: { engine: "llama", model: "m", reason: "manual" },
      identity: { files: [file] },
      harness: { windowCap: 32768 },
      progress: { trials, phases: { A: "passed" }, paused: {}, stepCrashes: {} },
      stopServer: async () => undefined,
      record: (t: TrialRecord) => trials.push(t),
      save: () => undefined,
      log: () => undefined,
    }) as unknown as PhaseContext;
  it("free memory higher on resume, hard W the same: the B trials are kept; a different hard W drops them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-ext-resume-"));
    try {
      const f = join(dir, "m.gguf");
      writeGguf(f, [
        ["general.architecture", "lfm3"],
        ["lfm3.block_count", 2],
        ["lfm3.attention.head_count", 2],
        ["lfm3.embedding_length", 64],
        ["lfm3.attention.head_count_kv", 1],
      ]);
      const first = await measureWindow(ctxOver(f, []), 0, 2304);
      expect(first).not.toBeNull();
      const hard = first!.hard;
      const fact = (i: number): TrialRecord => ({ step: "B/fact/4096", seed: i, outcome: "pass", at: "t", data: { counter: "main", index: i } });
      // An earlier run measured far less free memory (1 MiB, a soft W of 2304) with the same hard W.
      const earlier = (oldHard: number): TrialRecord[] => [
        { step: "B/window", seed: 0, outcome: "pass", at: "t", data: { window_tokens: 2304, hard_window_tokens: oldHard, free_ram_bytes: 2 ** 20 } },
        fact(0),
        fact(1),
      ];
      const kept = earlier(hard);
      await measureWindow(ctxOver(f, kept), 0, 2304);
      expect(kept.filter((t) => t.step === "B/fact/4096")).toHaveLength(2);
      const changed = earlier(hard - 256);
      const ctx = ctxOver(f, changed);
      await measureWindow(ctx, 0, 2304);
      expect(ctx.progress.trials.filter((t) => t.step === "B/fact/4096")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
