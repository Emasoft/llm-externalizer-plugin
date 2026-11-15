// C4-12 (TRDD-APQ601NV): the receipt line and the lifetime Jev totals, one test per acceptance box. Real runner, real P-01/P-02 recorded replies through the GlobalFetch seam; the usage history is a real file in a temp config dir.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../config.js";
import { spec as filterSpec } from "./catalog/filter.js";
import { replayFixture, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import { runDecisionArgv, type ArgvDeps } from "./run-decision.js";
import { readAllFrom } from "../cli/read-all.js";
import { buildReceipt, renderReceipt, SMALL_INPUT_TOKENS } from "./receipt.js";
import { DECISION_SPECS } from "./catalog/index.js";
import { estimateTokens } from "./l1/estimate.js";
import { formatHistoryLine, getHistoryPath, lifetimeJevTotals, parseHistoryLine, readHistory } from "../usage-history.js";

const KEY = "[REDACTED:openai-key]";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

// WHY relabeled: the recorded P-01 reply answers one question under another key; the runner asks p_i0.., so the real reply is re-keyed to the request.
function relabeled(questions: Record<string, unknown>): Response {
  const rec = fx("p01", "dec-noul");
  const body = JSON.parse(rec.body) as { answers: Record<string, unknown> };
  const real = body.answers.is_bug!;
  body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, real]));
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}

function serve(): { fetch: GlobalFetch; decisions: number } {
  const state = { decisions: 0 };
  const fetch: GlobalFetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    state.decisions++;
    return relabeled((JSON.parse(String(init.body)) as { questions: Record<string, unknown> }).questions);
  };
  return { fetch, get decisions() { return state.decisions; } };
}

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-c412-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, C412_TEST_KEY: process.env.C412_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.C412_TEST_KEY = KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const profile = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$C412_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2 } as unknown as Profile;
const items = (texts: string[]) => JSON.stringify({ question: "Does it fail?", items: texts.map((text, k) => ({ id: `f.log:${k + 1}`, text })) });
// WHY a function (TRDD-S3QEQBYV): a stream is consumed once, so every call builds a new ended PassThrough holding the bytes.
const endedStream = (text: string): PassThrough => { const s = new PassThrough(); s.end(Buffer.from(text)); return s; };

async function run(texts: string[], flags: string[] = []): Promise<{ code: number; out: string[]; err: string[]; decisions: number }> {
  const s = serve();
  const out: string[] = [];
  const err: string[] = [];
  const deps: ArgvDeps = {
    settings: { active: "c", active_classifier: "c", profiles: { c: profile } },
    fetch: s.fetch,
    catalogOptions: { path: join(tmp, "catalog.json") },
    sigint: new EventEmitter(),
    // WHY (TRDD-S3QEQBYV): readFile is unreachable here because run-decision.ts:547 reads a file only with --input; the real reader is passed so that no double remains.
    readFile: (p) => readFileSync(p, "utf8"),
    // WHY (TRDD-S3QEQBYV): data site. An ended stream can be read only once and this file calls run() 9 times; building the stream inside the closure means no stream is shared across runs (readStdinOnce calls the closure at most once per run).
    readStdin: () => readAllFrom(endedStream(items(texts))),
    stdout: (t) => out.push(t),
    stderr: (l) => err.push(l),
  };
  const code = await runDecisionArgv(filterSpec, ["--profile", "c", ...flags], deps);
  return { code, out, err, decisions: s.decisions };
}

// WHY the clause is optional: it is left out when no tokens were spared (review of 4acc83bb), and this tiny input spares none.
const RECEIPT_LINE = /^— 2 scanned · \d+\.\ds · jev 584 tok \(\$0\.0000\) · via typesafe\/jev-1\.13-20260917( · ~\d+ Claude tokens not read \(estimated\))?$/;

describe("C4-12 receipt line", () => {
  it("text mode: the receipt is the last line of stdout in the qs format (items, time, Jev tokens and cost, model, estimated tokens not read)", async () => {
    const r = await run(["boom 1", "boom 2"]);
    expect(r.code).toBe(0);
    expect(r.decisions).toBe(2);
    const last = r.out.join("\n").split("\n").at(-1)!;
    expect(last).toMatch(RECEIPT_LINE);
  });

  it("the not-read figure says it is estimated, and the pure renderer prints skipped inputs before the line", () => {
    const rc = buildReceipt({ elapsedMs: 1234, states: ["x".repeat(4000)], shown: "ok", usage: { input_tokens: 2500 }, cost: { usd: 0.01234, cost_estimated: true }, snapshots: ["m-1", "m-2"], inputWarnings: ["a.bin: invalid UTF-8 replaced with U+FFFD", "skipped b.lock: lock file", "skipped c.png: binary"] });
    const text = renderReceipt(rc, null).split("\n");
    expect(text).toEqual([
      "— skipped 2: b.lock: lock file, c.png: binary",
      `— 1 scanned · 1.2s · jev 2.5k tok ($0.0123 estimated) · via m-1, m-2 · ~${(rc.notReadEstimateTokens / 1000).toFixed(1)}k Claude tokens not read (estimated)`,
    ]);
    expect(rc.notReadEstimateTokens).toBeGreaterThan(1000);
  });

  it("--json: stdout stays one JSON document and the receipt goes to stderr", async () => {
    const r = await run(["boom 1", "boom 2"], ["--json"]);
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ schema: 1 });
    expect(r.err.at(-1)).toMatch(RECEIPT_LINE);
  });
});

describe("C4-12 an estimate is never chart data", () => {
  it("the lifetime totals hold measured numbers only, and the history line has no not-read figure", async () => {
    await run(["boom 1", "boom 2"]);
    expect(Object.keys(lifetimeJevTotals(readHistory())).sort()).toEqual(["costUsd", "inputTokens", "requests", "runs", "since"]);
    expect(readFileSync(getHistoryPath(), "utf8")).not.toMatch(/not.?read/i);
  });

  it("--estimate prints no receipt and records nothing in the history", async () => {
    const r = await run(["boom 1", "boom 2"], ["--estimate"]);
    expect(r.decisions).toBe(0);
    expect(r.out.join("\n")).not.toContain("Claude tokens not read");
    expect(readHistory()).toEqual([]);
  });
});

describe("C4-12 lifetime Jev totals in the usage history", () => {
  it("each billed request writes its measured input tokens, and the second run shows the sum of both runs", async () => {
    await run(["boom 1", "boom 2"]);
    expect(readHistory().map((e) => e.inputTokens)).toEqual([292, 292]);
    const second = await run(["boom 1", "boom 2"]);
    expect(second.out.join("\n")).toMatch(/\n— lifetime: 2 runs · 4 requests · jev 1\.2k tok \(\$0\.0000\) since \d{4}-\d{2}-\d{2}\n— 2 scanned/);
    expect(lifetimeJevTotals(readHistory())).toMatchObject({ runs: 2, requests: 4, inputTokens: 1168 });
  });

  it("the tokens field round-trips through the line format, and a line written before it still reads", () => {
    const base = { timestamp: "2026-10-31T09:08:07+0100", project: "/p", tool: "classify", params: "", ok: true, durationMs: 5, costUsd: 0.5, opId: "op-deadbeef" };
    const withTokens = parseHistoryLine(formatHistoryLine({ ...base, endpoint: "decisions", inputTokens: 292 }));
    expect(withTokens).toMatchObject({ endpoint: "decisions", inputTokens: 292 });
    expect(parseHistoryLine(formatHistoryLine({ ...base, endpoint: "decisions" })).inputTokens).toBeUndefined();
    expect(() => formatHistoryLine({ ...base, inputTokens: -1 })).toThrow(RangeError);
  });

  it("an unreadable history does not fail the run: the receipt says the totals are unavailable", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmp, "history.log"), "garbage\n");
    const r = await run(["boom 1", "boom 2"]);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("— lifetime Jev totals unavailable: ");
  });
});

describe("C4-12 E132 small input", () => {
  it("under about 1,000 tokens the run still happens and the receipt says Claude could read it directly for less", async () => {
    const r = await run(["boom 1", "boom 2"]);
    expect(r.decisions).toBe(2);
    expect(r.out.join("\n")).toContain(`under ${SMALL_INPUT_TOKENS.toLocaleString("en-US")}): Claude could read it directly for less than this call costs`);
  });

  it("an input over 1,000 tokens gets no such note", async () => {
    const r = await run(["alpha beta gamma delta ".repeat(300), "boom 2"]);
    expect(r.out.join("\n")).not.toContain("Claude could read it directly");
  });
});

describe("receipt not-read clause", () => {
  // Round 2, minor c: the clause is left out at 0, so a test that only checks its absence could pass with the clause deleted for good.
  it("is printed when the printed text is much shorter than the input", () => {
    const r = buildReceipt({ elapsedMs: 1000, states: ["x".repeat(40_000)], shown: "ok", usage: { input_tokens: 5 }, cost: { usd: 0.0001, cost_estimated: false }, snapshots: ["m"], inputWarnings: [] });
    expect(r.notReadEstimateTokens).toBeGreaterThan(1000);
    expect(renderReceipt(r, null)).toMatch(/ · ~\d+(\.\d)?k? Claude tokens not read \(estimated\)$/);
  });
});

// Quality eval of run 20261031_191133: compare and extract carry their documents in the shared state, decide and check build no units; the receipt counted unit states only ("about 4 tokens", "0 scanned").
describe("receipt counts each verb from its own content", () => {
  const receiptOf = (id: string, raw: unknown) => {
    const s = DECISION_SPECS.find((x) => x.id === id)!;
    const t = Object.fromEntries(Object.entries(s.thresholds).map(([k, v]) => [k, v.default]));
    const b = s.build(s.input.parse(raw), t);
    return buildReceipt({ elapsedMs: 1, states: b.units.map((u) => u.state), shared: b.sharedState, unsplittable: Object.keys(b.unsplittable).length, shown: "", usage: { input_tokens: 1 }, cost: { usd: 0, cost_estimated: false }, snapshots: [], inputWarnings: [] });
  };
  const long = (word: string): string => `${word} `.repeat(600);
  it("compare: both passages count, and every aspect plus the overall relation is an item", () => {
    const a = long("alpha");
    const b = long("beta");
    const r = receiptOf("compare", { passage_a: a, passage_b: b, aspects: ["tone", "dates"] });
    expect(r.contentTokens).toBeGreaterThanOrEqual(estimateTokens(a) + estimateTokens(b));
    expect(r.items).toBe(3);
  });
  it("extract: the document counts, and each field is an item", () => {
    const document = `${long("invoice")}Total 12 EUR, before 10 EUR`;
    const r = receiptOf("extract", { document, fields: [{ id: "price", pattern: "[0-9]+ EUR", description: "the total", matches: { candidates: ["12 EUR", "10 EUR"] } }] });
    expect(r.contentTokens).toBeGreaterThanOrEqual(estimateTokens(document));
    expect(r.items).toBe(1);
  });
  it("decide: no units, so the recommendation and every candidate x requirement check are the items", () => {
    const evidence = long("evidence");
    const r = receiptOf("decide", { decision: "pick one", evidence, priorities: "first", candidates: [{ id: "a", description: "A" }, { id: "b", description: "B" }, { id: "c", description: "C" }], requirements: ["works offline", "no server"] });
    expect(r.items).toBe(7);
    expect(r.contentTokens).toBeGreaterThanOrEqual(estimateTokens(evidence));
  });
  it("check: no units, so each invariant is an item", () => {
    const r = receiptOf("check", { preset: "invariant-check", invariants: [{ text: "never negative" }, { text: "never above 100" }], before: long("before"), after: long("after") });
    expect(r.items).toBe(2);
    expect(r.contentTokens).toBeGreaterThanOrEqual(estimateTokens(long("before")));
  });
});
