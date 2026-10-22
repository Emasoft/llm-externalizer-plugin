// C4-01 (TRDD-BUL4EEBP): the generic runner end to end over the filter spec. Real catalog, endpoints and decisions replies recorded by P-01/P-02 (question keys re-labeled), served through the GlobalFetch seam; no network.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../config.js";
import { VERIFY_POLICY } from "./l1/validate.js";
import { spec as filterSpec } from "./catalog/filter.js";
import { spec as labelSpec } from "./catalog/label.js";
import type { AnySpec, ProjectCtx } from "./catalog/spec.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import { runDecision, runDecisionArgv, type RunDeps, type RunRequest } from "./run-decision.js";

const KEY = "sk-or-v1-C401SECRETKEYVALUE0123456789abcdef";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

// P-01 dec-noul answers one question under the key "is_bug"; the runner asks p_i0.. so the real reply is re-labeled to the keys of the request.
function relabeled(questions: Record<string, unknown>, noul?: (key: string) => number, dropCost = false): Response {
  const rec = fx("p01", "dec-noul");
  const body = JSON.parse(rec.body) as { answers: Record<string, { type: string; noul: number }>; usage: { cost?: number } };
  if (dropCost) delete body.usage.cost;
  const real = body.answers.is_bug!;
  body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { ...real, noul: noul?.(k) ?? real.noul }]));
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}

interface Served { fetch: GlobalFetch; urls: string[]; decisions: { questions: Record<string, unknown>; auth: string }[] }
function serve(onDecision: (n: number, questions: Record<string, unknown>) => Response): Served {
  const decisions: Served["decisions"] = [];
  const urls: string[] = [];
  const fetch: GlobalFetch = async (url, init) => {
    urls.push(url);
    if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
    decisions.push({ questions: body.questions, auth: String((init.headers as Record<string, string>).Authorization) });
    return onDecision(decisions.length, body.questions);
  };
  return { fetch, urls, decisions };
}

// A catalog whose price for the test model is unreadable plus replies without usage.cost: the cost of a billed reply cannot be estimated, which makes the real usage recorder throw a plain Error (an unclassified error, not billed).
function unpriced(): Served {
  const s = serve((_n, q) => relabeled(q, undefined, true));
  const fetch: GlobalFetch = async (url, init) => {
    if (!url.includes("output_modalities=decisions")) return s.fetch(url, init);
    const rec = fx("p02", "models-decisions");
    const body = JSON.parse(rec.body) as { data: { id: string; pricing: { prompt: string } }[] };
    body.data.find((m) => m.id === "typesafe/jev-1.13")!.pricing.prompt = "n/a";
    return replayFixture({ ...rec, body: JSON.stringify(body) });
  };
  return { ...s, fetch };
}

const profile = (over: Record<string, unknown> = {}): Profile => ({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$C401_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2, ...over }) as unknown as Profile;

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-c401-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, C401_TEST_KEY: process.env.C401_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.C401_TEST_KEY = KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const depsOf = (fetch: GlobalFetch, over: Record<string, unknown> = {}): RunDeps => ({
  settings: { active: "c", active_classifier: "c", profiles: { c: profile(over) } },
  fetch,
  catalogOptions: { path: join(tmp, "catalog.json") },
  sigint: new EventEmitter(),
});
const filterReq = (n: number, over: Partial<RunRequest> = {}): RunRequest => ({
  input: { question: "Does it fail?", items: Array.from({ length: n }, (_, k) => ({ id: `f.log:${k + 1}`, text: `line number ${k}` })) },
  ...over,
});

describe("runDecision (filter spec, replayed replies)", () => {
  it("filter text mode over two items: matched rows, usage and cost summed, exit 0, inputs warnings coded", async () => {
    const s = serve((_n, q) => relabeled(q));
    const out = await runDecision(filterSpec, filterReq(2, { inputWarnings: ["a.log: invalid UTF-8 replaced with U+FFFD", "a.log: 1 secret redacted before send"] }), depsOf(s.fetch));
    expect(out.cause).toBeUndefined();
    expect(out.exitCode).toBe(0);
    const env = out.envelope!;
    expect((env.decision as { matched_count: number }).matched_count).toBe(2);
    expect(env.usage).toEqual({ input_tokens: 584, output_tokens: 42 });
    expect(env.cost.usd).toBeCloseTo(2 * 0.000012264, 12);
    expect(env.cost.cost_estimated).toBe(false);
    expect(env.snapshots).toEqual(["typesafe/jev-1.13-20260917"]);
    expect(env.stopped).toBeNull();
    expect(env.warnings.map((w) => w.code)).toEqual(["invalid_utf8", "secret_redacted"]);
    expect(s.decisions).toHaveLength(2);
    expect(s.decisions.every((d) => d.auth === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.parse(out.text!)).toEqual(JSON.parse(JSON.stringify(env)));
  });

  it("a fatal 401 on the first request: exit 3, the cause named once, no further request", async () => {
    const s = serve(() => replayFixture(fx("p01", "dec-err401")));
    const out = await runDecision(filterSpec, filterReq(5), depsOf(s.fetch, { concurrency: 1 }));
    expect(out.exitCode).toBe(3);
    expect(out.envelope).toBeUndefined();
    expect(out.cause!.match(/User not found/g)).toHaveLength(1);
    expect(s.decisions).toHaveLength(1);
  });

  it("a planner refusal (more requests than the profile allows): exit 1, one-line cause, no request sent", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const out = await runDecision(filterSpec, filterReq(2), depsOf(s.fetch, { max_requests_per_call: 1 }));
    expect(out.exitCode).toBe(1);
    expect(out.cause).toMatch(/needs 2 requests, over the limit of 1/);
    expect(s.decisions).toHaveLength(0);
  });

  it("--max-budget stop: the envelope says stopped budget, the unsent items are not_sent_budget, exit 1", async () => {
    const s = serve((_n, q) => relabeled(q));
    // Cap between one request (1.2264e-5) and two (2.45e-5) so exactly two go out, yet above the pre-flight input estimate of all three.
    const out = await runDecision(filterSpec, filterReq(3, { maxBudgetUsd: 2.4e-5 }), depsOf(s.fetch, { concurrency: 1 }));
    expect(out.envelope!.stopped).toBe("budget");
    expect(out.exitCode).toBe(1);
    expect(s.decisions).toHaveLength(2);
    expect((out.envelope!.decision as { invalid: { reason: string }[] }).invalid[0]!.reason).toMatch(/^not_sent_budget/);
  });

  it("--max-budget below the estimate is refused before any request", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const out = await runDecision(filterSpec, filterReq(2, { maxBudgetUsd: 1e-12 }), depsOf(s.fetch));
    expect(out.exitCode).toBe(1);
    expect(out.cause).toMatch(/exceeds --max-budget/);
    expect(s.decisions).toHaveLength(0);
  });

  it("a chunked text item: the merged answer reaches project under the item's own key", async () => {
    const s = serve((_n, q) => relabeled(q, (k) => (k.endsWith("#c2") ? 0.99 : 0.2)));
    const text = Array.from({ length: 120 }, (_, k) => `log line ${k} with some padding text`).join("\n");
    const out = await runDecision(filterSpec, { input: { question: "Does it fail?", items: [{ id: "big.log", text }] }, chunkChars: 1000 }, depsOf(s.fetch));
    expect(s.decisions.length).toBeGreaterThan(1);
    const rows = (out.envelope!.decision as { rows: { id: string; p: number }[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "big.log", p: 0.99 });
  });

  it("the key never appears in the envelope, the report file or the cause, even when the server echoes it", async () => {
    const ok = serve((_n, q) => relabeled(q));
    const dir = join(tmp, "out");
    const out = await runDecision(filterSpec, filterReq(1, { outputDir: dir }), depsOf(ok.fetch));
    const reports = readdirSync(dir);
    expect(reports).toHaveLength(1);
    expect(out.reportPath).toBe(join(dir, reports[0]!));
    const report = readFileSync(out.reportPath!, "utf8");
    expect(report).toBe(out.text);
    expect(JSON.stringify(out.envelope) + report + out.text!).not.toContain(KEY);

    const echo = serve(() => syntheticResponse(401, JSON.stringify({ error: { message: `bad key ${KEY}`, code: 401 } })));
    const bad = await runDecision(filterSpec, filterReq(1), depsOf(echo.fetch));
    expect(bad.exitCode).toBe(3);
    expect(bad.cause).not.toContain(KEY);
  });

  it("an unset key variable is exit 3 naming the variable, with no request", async () => {
    delete process.env.C401_TEST_KEY;
    const s = serve(() => { throw new Error("must not be called"); });
    const out = await runDecision(filterSpec, filterReq(1), depsOf(s.fetch));
    expect(out.exitCode).toBe(3);
    expect(out.cause).toContain("C401_TEST_KEY");
    expect(s.decisions).toHaveLength(0);
  });

  it("refusals of the input: schema, threshold range", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const bad = await runDecision(filterSpec, { input: { question: "q", items: [] } }, depsOf(s.fetch));
    expect(bad.exitCode).toBe(1);
    expect(bad.cause).toMatch(/^invalid input: items/);
    const range = await runDecision(filterSpec, filterReq(1, { thresholdFlags: { threshold: "7" } }), depsOf(s.fetch));
    expect(range.exitCode).toBe(1);
    expect(range.cause).toMatch(/--threshold must be a number from 0 to 1/);
  });
});

describe("runDecisionArgv", () => {
  const io = (stdin: string, s: Served) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, deps: { ...depsOf(s.fetch), readFile: (p: string) => { throw new Error(`no file ${p}`); }, readStdin: async () => Buffer.from(stdin), stdout: (t: string) => out.push(t), stderr: (l: string) => err.push(l) } };
  };
  const input = JSON.stringify({ question: "Does it fail?", items: [{ text: "boom" }] });

  it("reads JSON from stdin, applies a spec-declared threshold flag, prints the envelope", async () => {
    const s = serve((_n, q) => relabeled(q));
    const { out, err, deps } = io(input, s);
    const code = await runDecisionArgv(filterSpec, ["--threshold", "0.8", "--band=0.01", "--profile", "c"], deps);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    const env = JSON.parse(out[0]!) as { decision: { threshold: number; matched_count: number } };
    expect(env.decision.threshold).toBe(0.8);
    expect(env.decision.matched_count).toBe(1);
    expect(err).toEqual([]);
  });

  it("an unknown flag and a non-JSON stdin are exit 1 with one stderr line, before any request", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const a = io(input, s);
    expect(await runDecisionArgv(filterSpec, ["--nope", "1"], a.deps)).toBe(1);
    expect(a.err).toEqual(["llm-ext: unknown option --nope for classify filter"]);
    const b = io("not json", s);
    expect(await runDecisionArgv(filterSpec, [], b.deps)).toBe(1);
    expect(b.err[0]).toMatch(/cannot read the JSON input from stdin/);
    expect(s.decisions).toHaveLength(0);
  });
});

// ---- Review round on C4-01 (owner ruling: ultrafast or nothing) ----
describe("review round: latency", () => {
  it("a warm run of one question makes exactly ONE network call (the decisions request): catalog and endpoint limit come from the disk cache", async () => {
    const cold = serve((_n, q) => relabeled(q));
    const deps = depsOf(cold.fetch);
    await runDecision(filterSpec, filterReq(1), deps);
    expect(cold.urls.filter((u) => u.endsWith("/endpoints"))).toHaveLength(1);
    const warm = serve((_n, q) => relabeled(q));
    const out = await runDecision(filterSpec, filterReq(1), depsOf(warm.fetch));
    expect(out.exitCode).toBe(0);
    expect(warm.urls).toHaveLength(1);
    expect(warm.decisions).toHaveLength(1);
    expect(out.envelope!.warnings).toEqual([]);
  });

  it("synthetic: the endpoints lookup is down: the run proceeds with the catalog length and an endpoint_limit_unknown warning", async () => {
    const fetch: GlobalFetch = async (url, init) => {
      if (url.endsWith("/endpoints")) return syntheticResponse(503, "down");
      return serve((_n, q) => relabeled(q)).fetch(url, init);
    };
    const out = await runDecision(filterSpec, filterReq(1), depsOf(fetch));
    expect(out.exitCode).toBe(0);
    expect(out.envelope!.warnings.map((w) => w.code)).toEqual(["endpoint_limit_unknown"]);
  });
});

describe("review round: warnings, billing, redaction, context", () => {
  it("an unknown input warning is kept as input_warning, never a throw, and converted before any request", async () => {
    const s = serve(() => replayFixture(fx("p01", "dec-err401")));
    const out = await runDecision(filterSpec, filterReq(1, { inputWarnings: ["a.log: some new wording"] }), depsOf(s.fetch));
    expect(out.exitCode).toBe(3);
    const ok = serve((_n, q) => relabeled(q));
    const done = await runDecision(filterSpec, filterReq(1, { inputWarnings: ["a.log: some new wording"] }), depsOf(ok.fetch));
    expect(done.envelope!.warnings).toEqual([{ code: "input_warning", message: "a.log: some new wording" }]);
  });

  it("a reply billed and then refused is counted in the envelope usage and cost", async () => {
    const s = serve((n, q) => {
      if (n === 1) return relabeled(q);
      const rec = fx("p01", "dec-noul");
      return replayFixture({ ...rec, body: JSON.stringify({ ...(JSON.parse(rec.body) as object), answers: null }) });
    });
    const out = await runDecision(filterSpec, filterReq(2), depsOf(s.fetch, { concurrency: 1 }));
    expect(out.exitCode).toBe(5);
    expect(out.envelope!.usage.input_tokens).toBe(584);
    expect(out.envelope!.cost.usd).toBeCloseTo(2 * 0.000012264, 12);
    const d = out.envelope!.decision as { matched_count: number; invalid: { reason: string }[] };
    expect(d.matched_count).toBe(1);
    expect(d.invalid).toHaveLength(1);
  });

  it("a bug that throws with the key in its message leaves runDecision redacted, with no cause chain", async () => {
    const leaky = { ...filterSpec, project: () => { throw new Error(`boom ${KEY}`); } };
    const s = serve((_n, q) => relabeled(q));
    const err = await runDecision(leaky, filterReq(1), depsOf(s.fetch)).then(() => undefined, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("boom");
    expect(err!.message + (err!.stack ?? "")).not.toContain(KEY);
    expect(err!.cause).toBeUndefined();
  });

  it("forwards Built.truncated and the chunk metadata of a chunked item to project", async () => {
    let seen: ProjectCtx | undefined;
    const probe = { ...filterSpec, build: (i: never, t: never) => ({ ...filterSpec.build(i, t), truncated: true }), project: (a: never, i: never, t: never, ctx: ProjectCtx) => { seen = ctx; return filterSpec.project(a, i, t, ctx); } };
    const s = serve((_n, q) => relabeled(q));
    const text = Array.from({ length: 120 }, (_, k) => `log line ${k} with some padding text`).join("\n");
    await runDecision(probe, { input: { question: "Does it fail?", items: [{ id: "big.log", text }] }, chunkChars: 1000 }, depsOf(s.fetch));
    expect(seen!.truncated).toBe(true);
    expect(seen!.chunks!["p_i0"]).toMatchObject({ chunks: expect.any(Number) });
    expect(seen!.chunks!["p_i0"]!.chunks).toBeGreaterThan(1);
  });
});

describe("review round: --default and exit-code severity", () => {
  // Three classes, a two-chunk-or-more text: chunk 1 says opt1, every other chunk says opt2 (the last class, the spec default).
  const choiceReply = (q: Record<string, unknown>): Response => {
    const rec = fx("p01", "dec-choice3");
    const body = JSON.parse(rec.body) as { answers: Record<string, unknown> };
    body.answers = Object.fromEntries(Object.keys(q).map((k) => {
      const top = k.endsWith("#c1") ? "opt1" : "opt2";
      const probabilities = top === "opt1" ? { opt0: 0.1, opt1: 0.6, opt2: 0.3 } : { opt0: 0.1, opt1: 0.3, opt2: 0.6 };
      return [k, { type: "choice", choice: top, probabilities, confidence: 0.3 }];
    }));
    return replayFixture({ ...rec, body: JSON.stringify(body) });
  };
  const text = Array.from({ length: 120 }, (_, k) => `log line ${k} with some padding text`).join("\n");
  const labelReq = (over: Partial<RunRequest> = {}): RunRequest => ({ input: { mode: "files", items: [{ id: "a.log", text }], classes: [{ id: "opt0" }, { id: "opt1" }, { id: "opt2" }] }, chunkChars: 1000, ...over });

  it("--default <label> replaces the spec default for every choice question (it decides which chunks vote)", async () => {
    const spec = await runDecision(labelSpec, labelReq(), depsOf(serve((_n, q) => choiceReply(q)).fetch));
    expect((spec.envelope!.decision as { rows: { label: string }[] }).rows[0]!.label).toBe("opt1");
    const user = await runDecision(labelSpec, labelReq({ defaultLabel: "opt1" }), depsOf(serve((_n, q) => choiceReply(q)).fetch));
    expect((user.envelope!.decision as { rows: { label: string }[] }).rows[0]!.label).toBe("opt2");
  });

  it("--default with a label that is not a class, or on a spec with no choice over text, is a refusal before any request", async () => {
    const s = serve(() => { throw new Error("must not be called"); });
    const bad = await runDecision(labelSpec, labelReq({ defaultLabel: "nope" }), depsOf(s.fetch));
    expect(bad.exitCode).toBe(1);
    expect(bad.cause).toMatch(/--default "nope" is not a label/);
    const na = await runDecision(filterSpec, filterReq(1, { defaultLabel: "x" }), depsOf(s.fetch));
    expect(na.exitCode).toBe(1);
    expect(na.cause).toMatch(/--default does not apply/);
    expect(s.decisions).toHaveLength(0);
  });

  it("with failures of several classes the most severe code wins (3 > 4 > 5), not the first: a 503 first, a 400 later gives 4", async () => {
    const s = serve((n, q) => (n === 1 ? syntheticResponse(503, "unavailable") : n === 2 ? replayFixture(fx("p01", "dec-err400-malformed")) : relabeled(q)));
    const out = await runDecision(filterSpec, filterReq(3), depsOf(s.fetch, { concurrency: 1 }));
    expect(out.envelope).toBeDefined();
    expect(out.exitCode).toBe(4);
  });
});

describe("review round: argv values", () => {
  const run = async (argv: string[]) => {
    const err: string[] = [];
    const s = serve(() => { throw new Error("must not be called"); });
    const code = await runDecisionArgv(filterSpec, argv, { ...depsOf(s.fetch), readFile: () => "{}", readStdin: async () => Buffer.from("{}"), stdout: () => undefined, stderr: (l) => err.push(l) });
    return { code, err };
  };
  it.each([
    [["--max-budget="], "--max-budget needs a value"],
    [["--max-budget=abc"], '--max-budget needs a number, got "abc"'],
    [["--chunk-chars", " "], '--chunk-chars needs a number, got " "'],
    [["--profile", "--max-budget", "5"], "--profile needs a value"],
    [["-o"], "-o needs a value"],
    [["--threshold", "--band", "0.1"], "--threshold needs a value"],
  ])("%j is refused: %s", async (argv, line) => {
    const r = await run(argv);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([`llm-ext: ${line}`]);
  });
});

// Plan row E65 and review round: a build that declares `noCall` makes no API call, any other zero-question build is refused, and a run builds once.
describe("review round: empty plan and single build", () => {
  const withBuild = (build: AnySpec["build"], project?: AnySpec["project"], attention?: AnySpec["attention"]): AnySpec => ({ ...filterSpec, id: "fake", build, ...(project === undefined ? {} : { project }), attention: attention ?? (() => false) }) as unknown as AnySpec;
  const emptyBuilt = (over: Record<string, unknown> = {}) => ({ sharedState: null, units: [], unsplittable: {}, truncated: true, noCall: true as const, ...over });
  it("E65: a spec whose build declares noCall makes NO request, projects with empty answers and ctx.truncated, and exits 0", async () => {
    const s = serve((_n, q) => relabeled(q));
    const seen: { answers: unknown; truncated: boolean }[] = [];
    const fake = withBuild(() => emptyBuilt(), (answers, _i, _t, ctx) => { seen.push({ answers, truncated: ctx.truncated }); return { done: true }; });
    const out = await runDecision(fake, filterReq(1), depsOf(s.fetch));
    expect(s.urls).toHaveLength(0);
    expect(out.exitCode).toBe(0);
    expect(out.envelope!.decision).toEqual({ done: true });
    expect(seen).toEqual([{ answers: {}, truncated: true }]);
  });
  it("item 1: a zero-question build WITHOUT noCall is refused (exit 1, 'nothing to ask for this input'), nothing is sent and project never runs", async () => {
    const s = serve((_n, q) => relabeled(q));
    let projected = 0;
    const fake = withBuild(() => emptyBuilt({ noCall: undefined }), () => { projected++; return {}; });
    const out = await runDecision(fake, filterReq(1), depsOf(s.fetch));
    expect(out.exitCode).toBe(1);
    expect(out.cause).toBe("classify fake: nothing to ask for this input (no question was built)");
    expect(out.envelope).toBeUndefined();
    expect(s.urls).toHaveLength(0);
    expect(projected).toBe(0);
  });
  it("item 2: --default bogus is refused identically on the empty path and on a path with questions", async () => {
    const s = serve((_n, q) => relabeled(q));
    const empty = await runDecision(withBuild(() => emptyBuilt()), filterReq(1, { defaultLabel: "bogus", command: "classify x" }), depsOf(s.fetch));
    const asked = await runDecision(filterSpec, filterReq(1, { defaultLabel: "bogus", command: "classify x" }), depsOf(s.fetch));
    expect(asked.exitCode).toBe(1);
    expect(asked.cause).toMatch(/--default does not apply/);
    expect({ exitCode: empty.exitCode, cause: empty.cause }).toEqual({ exitCode: asked.exitCode, cause: asked.cause });
    expect(s.urls).toHaveLength(0);
  });
  it("item 4: the envelope of an empty run is well formed, the -o report equals stdout, and the exit code follows attention and --strict-exit", async () => {
    const s = serve((_n, q) => relabeled(q));
    const fake = withBuild(() => emptyBuilt(), () => ({ done: true }), () => true);
    const plain = await runDecision(fake, filterReq(1, { outputDir: join(tmp, "reports") }), depsOf(s.fetch));
    expect(plain.exitCode).toBe(0);
    const env = JSON.parse(plain.text!) as { schema: number; snapshots: unknown[]; usage: Record<string, unknown>; cost: Record<string, unknown>; warnings: unknown[]; degraded: unknown[]; stopped: unknown };
    expect(env).toMatchObject({ schema: 1, snapshots: [], usage: { input_tokens: 0, output_tokens: 0 }, cost: { usd: 0, cost_estimated: false }, warnings: [], degraded: [], stopped: null });
    expect(Number.isFinite(env.cost.usd)).toBe(true);
    expect(readFileSync(plain.reportPath!, "utf8")).toBe(plain.text);
    expect((await runDecision(fake, filterReq(1, { strictExit: true }), depsOf(s.fetch))).exitCode).toBe(1);
  });
  it("item 5: an empty run needs no classifier profile and no key (nothing is sent, and selecting a profile would itself fetch the catalog)", async () => {
    const urls: string[] = [];
    const deps: RunDeps = { settings: { active: undefined, active_classifier: undefined, profiles: {} }, fetch: async (url) => { urls.push(url); throw new Error("no network"); }, catalogOptions: { path: join(tmp, "catalog.json") }, sigint: new EventEmitter() };
    delete process.env.C401_TEST_KEY;
    const out = await runDecision(withBuild(() => emptyBuilt(), () => ({ done: true })), filterReq(1), deps);
    expect(out.exitCode).toBe(0);
    expect(urls).toEqual([]);
  });
  it("a run calls spec.build exactly once (the chunk-defaults check reuses the built job)", async () => {
    const s = serve((_n, q) => relabeled(q));
    let calls = 0;
    const counting = withBuild((i, t) => { calls++; return filterSpec.build(i as never, t); });
    const out = await runDecision(counting, filterReq(1), depsOf(s.fetch));
    expect(out.exitCode).toBe(0);
    expect(calls).toBe(1);
  });
});


describe("review round 4: the catalog is loaded once per run", () => {
  const catalogFetches = (urls: string[]): number => urls.filter((u) => u.includes("output_modalities=decisions")).length;

  it("warm cache: the catalog is not fetched at all", async () => {
    await runDecision(filterSpec, filterReq(1), depsOf(serve((_n, q) => relabeled(q)).fetch));
    const warm = serve((_n, q) => relabeled(q));
    const out = await runDecision(filterSpec, filterReq(1), depsOf(warm.fetch));
    expect(out.exitCode).toBe(0);
    expect(catalogFetches(warm.urls)).toBe(0);
  });

  it("selection and the runner share one load: with the cache never fresh (ttlMs 0) a run still fetches the catalog exactly once", async () => {
    const s = serve((_n, q) => relabeled(q));
    const deps = depsOf(s.fetch);
    const out = await runDecision(filterSpec, filterReq(1), { ...deps, catalogOptions: { ...deps.catalogOptions, ttlMs: 0 } });
    expect(out.exitCode).toBe(0);
    expect(catalogFetches(s.urls)).toBe(1);
  });

  it("a rejected first load is one failure mapped to exit 5, fetched once, with no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const urls: string[] = [];
      const fetch: GlobalFetch = async (url) => { urls.push(url); return syntheticResponse(503, "down"); };
      const out = await runDecision(filterSpec, filterReq(1), depsOf(fetch));
      await new Promise((r) => setTimeout(r, 20));
      expect(out.exitCode).toBe(5);
      expect(catalogFetches(urls)).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// Wave 9: the behaviours of run()'s tail that no other test pinned: Ctrl-C wiring and its dispose, the per-request timeout, the spec's split class and validation policy.
describe("wave 9: runPlan wiring", () => {
  const isDecision = (url: string): boolean => !url.includes("output_modalities=decisions") && !url.endsWith("/endpoints");

  it("Ctrl-C: the listener is installed while requests run, SIGINT ends the run with exit 130 keeping finished work, and the listener is gone afterwards", async () => {
    const sigint = new EventEmitter();
    const s = serve((n, q) => { if (n === 1) sigint.emit("SIGINT"); return relabeled(q); });
    const seenDuring: number[] = [];
    const fetch: GlobalFetch = async (url, init) => { if (isDecision(url)) seenDuring.push(sigint.listenerCount("SIGINT")); return s.fetch(url, init); };
    const out = await runDecision(filterSpec, filterReq(3), { ...depsOf(fetch, { concurrency: 1 }), sigint });
    expect(seenDuring[0]).toBe(1);
    expect(out.exitCode).toBe(130);
    expect(s.decisions).toHaveLength(1);
    expect(sigint.listenerCount("SIGINT")).toBe(0);
  });

  // A reply that arrives while Ctrl-C was pressed is billed; the run ends 130 and still counts it.
  it("follow-up 1: Ctrl-C while a request fails with an AbortError (before billing) is exit 130, never an internal error", async () => {
    const sigint = new EventEmitter();
    const s = serve((_n, q) => relabeled(q));
    const fetch: GlobalFetch = (url, init) => {
      if (!isDecision(url)) return s.fetch(url, init);
      sigint.emit("SIGINT");
      return Promise.reject(new DOMException("This operation was aborted", "AbortError"));
    };
    const out = await runDecision(filterSpec, filterReq(1), { ...depsOf(fetch), sigint });
    expect(out.exitCode).toBe(130);
    expect(`${out.cause ?? ""}${out.text ?? ""}`).not.toMatch(/internal error/);
  });
  it("follow-up 1: Ctrl-C while the reply is on its way: exit 130, no internal error, and the billed reply is counted", async () => {
    const sigint = new EventEmitter();
    const s = serve((_n, q) => relabeled(q));
    const fetch: GlobalFetch = (url, init) => { if (isDecision(url)) sigint.emit("SIGINT"); return s.fetch(url, init); };
    const out = await runDecision(filterSpec, filterReq(1), { ...depsOf(fetch), sigint });
    expect(out.exitCode).toBe(130);
    expect(`${out.cause ?? ""}${out.text ?? ""}`).not.toMatch(/internal error/);
    expect(out.envelope!.cost.usd).toBeCloseTo(0.000012264, 12);
  });

  // Follow-up 2: a programming error stays findable. The unclassified error is the real usage recorder refusing to estimate an unpriced reply.
  it("follow-up 2: the failure names the original error type, and its stack goes to deps.stderr once only under LLM_EXT_DEBUG", async () => {
    const written: string[] = [];
    try {
      const quiet = await runDecision(filterSpec, filterReq(1), { ...depsOf(unpriced().fetch, { concurrency: 1 }), stderr: (l) => written.push(l) });
      expect(quiet.exitCode).toBe(5);
      expect(quiet.cause).toMatch(/internal error in this request \(Error\)/);
      expect(written).toEqual([]);
      process.env.LLM_EXT_DEBUG = "1";
      await runDecision(filterSpec, filterReq(1), { ...depsOf(unpriced().fetch, { concurrency: 1 }), stderr: (l) => written.push(l) });
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/cannot estimate the cost of a reply/);
    } finally {
      delete process.env.LLM_EXT_DEBUG;
    }
  });

  it.each([["0"], [""], ["yes"]])("last pass 2: LLM_EXT_DEBUG=%j is off (no stack on stderr)", async (value) => {
    const written: string[] = [];
    try {
      process.env.LLM_EXT_DEBUG = value;
      const out = await runDecision(filterSpec, filterReq(1), { ...depsOf(unpriced().fetch, { concurrency: 1 }), stderr: (l) => written.push(l) });
      expect(out.exitCode).toBe(5);
      expect(written).toEqual([]);
    } finally {
      delete process.env.LLM_EXT_DEBUG;
    }
  });
  it("last pass 2: with LLM_EXT_DEBUG=true two failing requests print the stack ONCE (the first)", async () => {
    const written: string[] = [];
    try {
      process.env.LLM_EXT_DEBUG = "true";
      const s = unpriced();
      const out = await runDecision(filterSpec, filterReq(2), { ...depsOf(s.fetch, { concurrency: 1 }), stderr: (l) => written.push(l) });
      expect(out.exitCode).toBe(5);
      expect(s.decisions).toHaveLength(2);
      expect(written).toHaveLength(1);
    } finally {
      delete process.env.LLM_EXT_DEBUG;
    }
  });
  it("follow-up 5: a malformed model id from the catalog (empty path segment) is named in the warning and the endpoint lookup is not attempted", async () => {
    const BAD = "typesafe//jev-1.13";
    const s = serve((_n, q) => relabeled(q));
    const fetch: GlobalFetch = async (url, init) => {
      if (url.includes("output_modalities=decisions")) { const rec = fx("p02", "models-decisions"); return replayFixture({ ...rec, body: rec.body.replaceAll("typesafe/jev-1.13", BAD) }); }
      return s.fetch(url, init);
    };
    const out = await runDecision(filterSpec, filterReq(1), depsOf(fetch, { model: BAD }));
    expect(out.exitCode).toBe(0);
    expect(s.urls.filter((u) => u.endsWith("/endpoints"))).toEqual([]);
    const w = out.envelope!.warnings.find((x) => x.code === "endpoint_limit_unknown");
    expect(w?.message).toMatch(/malformed.*empty, "\." or "\.\." path segment/);
  });

  it("follow-up 3: a 200 reply with NO usage block is a classified refusal (bad-response, exit 5, 'missing or invalid usage'), never a TypeError from the success path", async () => {
    const s = serve(() => {
      const rec = fx("p01", "dec-noul");
      const body = JSON.parse(rec.body) as Record<string, unknown>;
      delete body.usage;
      return replayFixture({ ...rec, body: JSON.stringify(body) });
    });
    const out = await runDecision(filterSpec, filterReq(1), depsOf(s.fetch));
    expect(out.exitCode).toBe(5);
    expect(out.cause).toMatch(/missing or invalid usage/);
    expect(out.cause).not.toMatch(/internal error/);
  });

  it("dispose: after a normal run and after a fatal failure the SIGINT listener is removed", async () => {
    for (const reply of [(q: Record<string, unknown>) => relabeled(q), () => replayFixture(fx("p01", "dec-err401"))]) {
      const sigint = new EventEmitter();
      await runDecision(filterSpec, filterReq(1), { ...depsOf(serve((_n, q) => reply(q)).fetch), sigint });
      expect(sigint.listenerCount("SIGINT")).toBe(0);
    }
  });

  it("timeout_ms of the profile is the per-request deadline: a request that never answers ends as a timeout (exit 5) instead of hanging", async () => {
    const s = serve((_n, q) => relabeled(q));
    const fetch: GlobalFetch = (url, init) => isDecision(url)
      ? new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason), { once: true }))
      : s.fetch(url, init);
    const started = Date.now();
    const out = await runDecision(filterSpec, filterReq(1), depsOf(fetch, { timeout_ms: 50 }));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(out.exitCode).toBe(5);
  });

  it("split: a whole-result spec with a lost request has no envelope (exit 5), where a per-item spec projects the rest", async () => {
    const reply = (n: number, q: Record<string, unknown>): Response => (n === 2 ? syntheticResponse(503, "unavailable") : relabeled(q));
    const perItem = await runDecision(filterSpec, filterReq(2), depsOf(serve(reply).fetch, { concurrency: 1 }));
    const whole = await runDecision({ ...filterSpec, split: "whole-result" } as typeof filterSpec, filterReq(2), depsOf(serve(reply).fetch, { concurrency: 1 }));
    expect(perItem.envelope).toBeDefined();
    expect(whole.envelope).toBeUndefined();
    expect(whole.exitCode).toBe(5);
  });

  it("policy: spec.validation reaches the answer check (a malformed confidence is coerced under the default policy and rejected under VERIFY_POLICY)", async () => {
    const withConfidence = (q: Record<string, unknown>): Response => {
      const rec = fx("p01", "dec-noul");
      const body = JSON.parse(rec.body) as { answers: Record<string, Record<string, unknown>> };
      const real = body.answers.is_bug!;
      body.answers = Object.fromEntries(Object.keys(q).map((k) => [k, { ...real, confidence: "high" }]));
      return replayFixture({ ...rec, body: JSON.stringify(body) });
    };
    const loose = await runDecision(filterSpec, filterReq(1), depsOf(serve((_n, q) => withConfidence(q)).fetch));
    const strict = await runDecision({ ...filterSpec, validation: VERIFY_POLICY } as typeof filterSpec, filterReq(1), depsOf(serve((_n, q) => withConfidence(q)).fetch));
    expect((loose.envelope!.decision as { invalid: unknown[] }).invalid).toHaveLength(0);
    expect((strict.envelope!.decision as { invalid: unknown[] }).invalid).toHaveLength(1);
  });
});


// XZZ2NSWY: the runner awaits an optional spec.prepare once, after the cheap refusals, and its result is what build, chunkDefaults and project receive.
describe("spec.prepare (XZZ2NSWY)", () => {
  const isDecision = (url: string): boolean => !url.includes("output_modalities=decisions") && !url.endsWith("/endpoints");
  type FilterInput = Parameters<typeof filterSpec.build>[0];
  const withPrepare = (calls: unknown[][], prepare?: (i: FilterInput, signal: AbortSignal) => Promise<FilterInput>): typeof filterSpec => ({
    ...filterSpec,
    prepare: (i: FilterInput, t: Record<string, number>, o: { signal: AbortSignal }) => { calls.push([i, t, Object.keys(o)]); return prepare ? prepare(i, o.signal) : Promise.resolve(i); },
  }) as typeof filterSpec;

  it("a refused invocation starts no prepare: bad input, threshold, chunk size, budget and -o are all refused first", async () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    const refused: Partial<RunRequest>[] = [{ input: { nonsense: 1 } }, { thresholdFlags: { threshold: 5 } }, { chunkChars: 1 }, { maxBudgetUsd: -1 }, { outputDir: join(file, "sub") }];
    for (const over of refused) {
      const calls: unknown[][] = [];
      const out = await runDecision(withPrepare(calls), filterReq(1, over), depsOf(serve((_n, q) => relabeled(q)).fetch));
      expect(out.exitCode).toBe(1);
      expect(calls).toHaveLength(0);
    }
    const calls: unknown[][] = [];
    const ok = await runDecision(withPrepare(calls), filterReq(1), depsOf(serve((_n, q) => relabeled(q)).fetch));
    expect(ok.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("the runner hands prepare the parsed input, the thresholds and ONLY { signal }", async () => {
    const calls: unknown[][] = [];
    await runDecision(withPrepare(calls), filterReq(1), depsOf(serve((_n, q) => relabeled(q)).fetch));
    expect(calls[0]![2]).toEqual(["signal"]);
    expect(calls[0]![1]).toMatchObject({ threshold: 0.5 });
  });

  it("the prepared input is what build, chunkDefaults and project receive, not the caller's", async () => {
    const seen: Record<string, unknown> = {};
    const prepared = { question: "Does it fail?", items: [{ id: "f.log:1", text: "line number 0" }, { id: "f.log:2", text: "added by prepare" }] } as FilterInput;
    const probe = {
      ...withPrepare([], async () => prepared),
      build: (i: FilterInput, t: Record<string, number>) => { seen.build = i; return filterSpec.build(i, t); },
      chunkDefaults: (i: FilterInput) => { seen.chunkDefaults = i; return {}; },
      project: (a: never, i: FilterInput, t: never, c: never) => { seen.project = i; return filterSpec.project(a, i, t, c); },
    } as typeof filterSpec;
    const s = serve((_n, q) => relabeled(q));
    const out = await runDecision(probe, filterReq(1), depsOf(s.fetch));
    expect(out.exitCode).toBe(0);
    expect(seen.build).toBe(prepared);
    expect(seen.chunkDefaults).toBe(prepared);
    expect(seen.project).toBe(prepared);
    // WHY 2: the filter sends one request per item, and the caller gave one item; the second request is the item prepare added (planning read the prepared input).
    expect(s.decisions).toHaveLength(2);
  });

  it("Ctrl-C during prepare: the abort reaches prepare, the run ends 130 (no internal error), no request is sent, no report is written, and the SIGINT listener is gone", async () => {
    const sigint = new EventEmitter();
    const s = serve((_n, q) => relabeled(q));
    const reports = join(tmp, "reports-sigint");
    const listeners: number[] = [];
    const calls: unknown[][] = [];
    const hanging = withPrepare(calls, (_i, signal) => new Promise((_res, rej) => {
      listeners.push(sigint.listenerCount("SIGINT"));
      signal.addEventListener("abort", () => rej(signal.reason), { once: true });
      sigint.emit("SIGINT");
    }));
    const out = await runDecision(hanging, filterReq(1, { outputDir: reports }), { ...depsOf(s.fetch), sigint });
    expect(listeners).toEqual([1]);
    expect(out.exitCode).toBe(130);
    expect(`${out.cause ?? ""}${out.text ?? ""}`).not.toMatch(/internal error/);
    expect(s.urls.filter(isDecision)).toEqual([]);
    expect(readdirSync(reports)).toEqual([]);
    expect(sigint.listenerCount("SIGINT")).toBe(0);
  });

  it("a prepare that fails for another reason is a bug that surfaces, not a tidy exit code", async () => {
    const boom = withPrepare([], () => Promise.reject(new Error("worker could not start")));
    await expect(runDecision(boom, filterReq(1), depsOf(serve((_n, q) => relabeled(q)).fetch))).rejects.toThrow("worker could not start");
  });
});
