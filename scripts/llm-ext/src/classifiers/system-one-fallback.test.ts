// TRDD-28BAL5ER: the System One fallback of the decision runner. Recorded P-01/P-02 replies through the GlobalFetch seam; only the HTTP boundary is stubbed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../config.js";
import { readModelEvents } from "../model-events.js";
import { spec as filterSpec } from "./catalog/filter.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import { runDecision, type RunDeps, type RunRequest } from "./run-decision.js";

const KEY = "sk-or-v1-SYSONESECRETKEYVALUE0123456789abcdef";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

// The recorded catalog, edited by `edit` (the recorded one has several System One models cheaper than Jev).
type CatalogRow = { id: string; alias_target?: { slug: string }; pricing: { prompt: string }; description?: string };
function catalogWith(edit: (rows: CatalogRow[]) => CatalogRow[]): Response {
  const rec = fx("p02", "models-decisions");
  const body = JSON.parse(rec.body) as { data: CatalogRow[] };
  body.data = edit(body.data);
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}
const isSystemOne = (m: CatalogRow): boolean => /system\s*one/i.test(m.description ?? "") || /^~?typesafe\//.test(m.id);
const onlyJevAnd = (...keep: string[]) => (rows: CatalogRow[]): CatalogRow[] => rows.filter((m) => !isSystemOne(m) || m.id.includes("typesafe/") || keep.includes(m.id));

// The recorded decisions reply, re-keyed to the request's questions and signed by `model`.
function answered(questions: Record<string, unknown>, model: string): Response {
  const rec = fx("p01", "dec-noul");
  const body = JSON.parse(rec.body) as { model: string; answers: Record<string, unknown> };
  const real = body.answers.is_bug;
  body.answers = Object.fromEntries(Object.keys(questions).map((k) => [k, real]));
  body.model = model;
  return replayFixture({ ...rec, body: JSON.stringify(body) });
}

interface Served { fetch: GlobalFetch; models: string[] }
/** `reply(model, questions)` answers each decisions call; the models asked are recorded in order. */
function serve(catalog: Response | (() => Response), reply: (model: string, q: Record<string, unknown>) => Response): Served {
  const models: string[] = [];
  const fetch: GlobalFetch = async (url, init) => {
    if (url.includes("output_modalities=decisions")) return typeof catalog === "function" ? catalog() : catalog.clone();
    if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
    const body = JSON.parse(String(init.body)) as { model: string; questions: Record<string, unknown> };
    models.push(body.model);
    return reply(body.model, body.questions);
  };
  return { fetch, models };
}

const profile = (over: Record<string, unknown> = {}): Profile => ({ "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$SYSONE_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 1, ...over }) as unknown as Profile;

let tmp: string;
let prev: Record<string, string | undefined>;
let stderr: string[];
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-sysone-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, SYSONE_TEST_KEY: process.env.SYSONE_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.SYSONE_TEST_KEY = KEY;
  stderr = [];
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
  stderr: (l) => stderr.push(l),
});
const req = (): RunRequest => ({ input: { question: "Does it fail?", items: [{ id: "f.log:1", text: "line number 0" }] } });
const gone = (): Response => syntheticResponse(404, JSON.stringify({ error: { code: 404, message: "model typesafe/jev-1.13 does not exist" } }));

describe("System One fallback (TRDD-28BAL5ER)", () => {
  it("(a) no other System One model: Jev's own error is the result, unchanged, and nothing else is tried", async () => {
    const s = serve(() => catalogWith(onlyJevAnd()), () => gone());
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(4);
    expect(out.cause).toMatch(/API error 404/);
    expect(s.models).toEqual(["typesafe/jev-1.13"]);
    expect(stderr).toEqual([]);
  });

  it("(b) Jev 404 and a cheaper System One model: the fallback answers, the envelope and stderr name it", async () => {
    // mercury-decide:free (price 0) is the cheapest System One entry, so it is tried first.
    const s = serve(() => catalogWith(onlyJevAnd("inception/mercury-decide:free", "liquid/d1")), (model, q) => (model === "typesafe/jev-1.13" ? gone() : answered(q, model)));
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(0);
    expect(s.models).toEqual(["typesafe/jev-1.13", "inception/mercury-decide:free"]);
    expect(out.envelope!.snapshots).toEqual(["inception/mercury-decide:free"]);
    expect(out.envelope!.warnings.map((w) => w.code)).toContain("fallback_model");
    expect(stderr.join("\n")).toMatch(/answered by System One fallback inception\/mercury-decide:free/);
  });

  it("(b2) cheapest first, then id: the dearer fallback is tried only after the cheaper one also fails", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("inception/mercury-decide:free", "liquid/d1")), (model, q) => (model === "liquid/d1" ? answered(q, model) : gone()));
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(0);
    expect(s.models).toEqual(["typesafe/jev-1.13", "inception/mercury-decide:free", "liquid/d1"]);
  });

  it("(c) a 401 key error on Jev never falls back", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("liquid/d1")), () => syntheticResponse(401, JSON.stringify({ error: { code: 401, message: "User not found." } })));
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(3);
    expect(s.models).toEqual(["typesafe/jev-1.13"]);
  });

  it("(d) a System One model priced above Jev is skipped: Jev's error stands", async () => {
    // upstage/solar-decide-flash costs 5e-8 per token, Jev 4.2e-8.
    const s = serve(() => catalogWith(onlyJevAnd("upstage/solar-decide-flash")), (model, q) => (model === "typesafe/jev-1.13" ? gone() : answered(q, model)));
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(4);
    expect(out.cause).toMatch(/API error 404/);
    expect(s.models).toEqual(["typesafe/jev-1.13"]);
  });

  it("(e) an alias that resolves to another target than last recorded writes alias_target_change once", async () => {
    const aliasProfile = { model: "~typesafe/jev-latest" };
    const s = serve(() => catalogWith(onlyJevAnd()), (model, q) => answered(q, model));
    await runDecision(filterSpec, req(), depsOf(s.fetch, aliasProfile));
    await runDecision(filterSpec, req(), depsOf(s.fetch, aliasProfile));
    expect(readModelEvents().filter((e) => e.kind === "alias_target_change")).toMatchObject([{ model: "~typesafe/jev-latest", detail: "(unrecorded)→typesafe/jev-1.13" }]);
    // The alias now points at another build: one more event, naming the old target.
    const moved = serve(() => catalogWith((rows) => onlyJevAnd()(rows).map((m) => (m.id === "~typesafe/jev-latest" ? { ...m, alias_target: { slug: "typesafe/jev-1.14" } } : m)).concat([{ ...rows.find((m) => m.id === "typesafe/jev-1.13")!, id: "typesafe/jev-1.14" }])), (model, q) => answered(q, model));
    // WHY a second catalog file: the first one is still fresh in the cache and would hide the move.
    await runDecision(filterSpec, req(), { ...depsOf(moved.fetch, { model: "~typesafe/jev-latest" }), catalogOptions: { path: join(tmp, "catalog-moved.json") } });
    expect(readModelEvents().filter((e) => e.kind === "alias_target_change").map((e) => e.detail)).toEqual(["(unrecorded)→typesafe/jev-1.13", "typesafe/jev-1.13→typesafe/jev-1.14"]);
  });

  // Review round of TRDD-28BAL5ER.
  const reqN = (n: number): RunRequest => ({ input: { question: "Does it fail?", items: Array.from({ length: n }, (_, k) => ({ id: `f.log:${k + 1}`, text: `line number ${k}` })) } });
  const down = (): Response => syntheticResponse(503, "unavailable");
  const J = "typesafe/jev-1.13";
  const hangOn = (inner: GlobalFetch, model: string): GlobalFetch => (url, init) =>
    !url.includes("output_modalities=decisions") && !url.endsWith("/endpoints") && (JSON.parse(String(init.body)) as { model: string }).model === model
      ? new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason), { once: true }))
      : inner(url, init);

  it("(f) removed profile model with a recorded price: replaced by the cheapest System One model at or below it, the output names the rule and the model per item", async () => {
    writeFileSync(join(tmp, "system-one-state.json"), JSON.stringify({ aliases: {}, prices: { "typesafe/gone-1": 0.042 } }));
    const s = serve(() => catalogWith(onlyJevAnd("inception/mercury-decide:free", "liquid/d1", "upstage/solar-decide-flash")), (model, q) => answered(q, model));
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch, { model: "typesafe/gone-1" }));
    expect(out.exitCode).toBe(0);
    expect(s.models).toEqual(["inception/mercury-decide:free"]);
    expect(out.envelope!.warnings.find((w) => w.code === "profile_model_removed")!.message).toMatch(/last recorded prompt price \(0\.042/);
    expect(out.envelope!.answered_by).toEqual({ p_i0: "inception/mercury-decide:free" });
    expect(stderr.join("\n")).toMatch(/typesafe\/gone-1 is not in the decisions catalog.*quality not benchmarked against typesafe\/gone-1/);
  });

  it("(g) removed profile model never priced: the ceiling is the cheapest System One model of the catalog, and the output says so", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("inception/mercury-decide:free", "liquid/d1")), (model, q) => answered(q, model));
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch, { model: "typesafe/gone-1" }));
    expect(out.exitCode).toBe(0);
    expect(s.models).toEqual(["inception/mercury-decide:free"]);
    expect(out.envelope!.warnings.find((w) => w.code === "profile_model_removed")!.message).toMatch(/the cheapest System One model in the catalog .* no price was ever recorded/);
  });

  it("(g2) a successful run records the profile model's price, so the same model removed later is priced by it", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("liquid/d1")), (model, q) => answered(q, model));
    await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(JSON.parse(readFileSync(join(tmp, "system-one-state.json"), "utf8")).prices[J]).toBeCloseTo(0.042, 9);
  });

  it("(h) one transient 503 does not retire Jev: it is retried once and answers every request", async () => {
    let first = true;
    const s = serve(() => catalogWith(onlyJevAnd("liquid/d1")), (model, q) => { if (first) { first = false; return down(); } return answered(q, model); });
    const out = await runDecision(filterSpec, reqN(3), depsOf(s.fetch));
    expect(out.exitCode).toBe(0);
    expect(s.models).toEqual([J, J, J, J]);
    expect(out.envelope!.answered_by).toBeUndefined();
  });

  it("(i) two failures retire Jev for the run: the fallback answers, later requests go straight to it, and every item names its model", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("liquid/d1")), (model, q) => (model === J ? down() : answered(q, model)));
    const out = await runDecision(filterSpec, reqN(3), depsOf(s.fetch));
    expect(out.exitCode).toBe(0);
    expect(s.models).toEqual([J, J, "liquid/d1", "liquid/d1", "liquid/d1"]);
    expect(out.envelope!.answered_by).toEqual({ p_i0: "liquid/d1", p_i1: "liquid/d1", p_i2: "liquid/d1" });
  });

  it("(j) Jev 503 and the fallback 503: the same exit code and cause as before the change", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("liquid/d1")), () => down());
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(5);
    expect(out.cause).toMatch(/API error 503/);
  });

  it("(k) the candidates share the request's deadline: a fallback that hangs uses the rest of it and the next candidate is never asked", async () => {
    const s = serve(() => catalogWith(onlyJevAnd("inception/mercury-decide:free", "liquid/d1")), () => down());
    const started = Date.now();
    const out = await runDecision(filterSpec, req(), depsOf(hangOn(s.fetch, "inception/mercury-decide:free"), { timeout_ms: 300 }));
    expect(Date.now() - started).toBeLessThan(2500);
    expect(out.exitCode).toBe(5);
    expect(s.models).toEqual([J, J]);
  });

  it("(l) no price ceiling (Jev unpriced in the catalog): no fallback is tried and one stderr line says why", async () => {
    const s = serve(() => catalogWith((rows) => onlyJevAnd("liquid/d1")(rows).map((m) => (m.id === J ? { ...m, pricing: { prompt: "n/a" } } : m))), () => gone());
    const out = await runDecision(filterSpec, req(), depsOf(s.fetch));
    expect(out.exitCode).toBe(4);
    expect(s.models).toEqual([J]);
    expect(stderr.filter((l) => /no System One fallback tried/.test(l))).toHaveLength(1);
  });
});