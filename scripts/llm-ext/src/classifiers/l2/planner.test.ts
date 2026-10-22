// L2-01: planner core on real Question builders and the real token estimate; no doubles.
import { describe, expect, it } from "vitest";
import { noul } from "../l1/questions.js";
import { estimateTokens } from "../l1/estimate.js";
import type { DecisionsModel } from "../l0/catalog.js";
import { endpointPromptLimit, resolveModel } from "../l0/model.js";
import { ENVELOPE_TOKENS, chunkOf, modelLimits, planRequests, toGlobalIndex, type ModelLimits, type SplitJob } from "./planner.js";

const limits = (o: Partial<ModelLimits> = {}): ModelLimits => ({ contextTokens: 1000, envelopeTokens: 64, maxRequests: 100, concurrency: 4, ...o });
const atom = (i: number, text = "x".repeat(1600)) => ({ kind: "atomic" as const, state: { text }, questions: { [`q${i}`]: noul(`Is claim ${i} true?`) } });
const job = (units: SplitJob["units"], shared: unknown = "evidence"): SplitJob => ({ sharedState: shared, units, unsplittable: {} });

describe("planRequests", () => {
  it("packs atomic units greedily in input order, each request within limit minus envelope", () => {
    // 600 x-chars are about 200 tokens at the letter rate (1/3), so several units still share one request under the 1000-token limit.
    const plan = planRequests(job([0, 1, 2, 3, 4].map((i) => atom(i, "x".repeat(600)))), limits());
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(1);
    expect(plan.requests.length).toBeLessThan(5);
    expect(plan.requests.flatMap((r) => r.units.map((u) => Object.keys(u.questions)[0]))).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    let offset = 0;
    for (const r of plan.requests) {
      expect(r.offset).toBe(offset);
      offset += r.units.length;
      expect(r.tokens).toBeLessThanOrEqual(1000);
      expect(estimateTokens({ state: r.state, questions: r.questions })).toBeLessThanOrEqual(1000 - 64);
      expect(r.state.units).toEqual(r.units.map((u) => u.state));
      expect(Object.keys(r.questions)).toEqual(r.units.map((u) => Object.keys(u.questions)[0]));
    }
    // Greedy: every request but the last is full, i.e. the next unit would not have fit.
    expect(plan.requests[0]!.units.length).toBeGreaterThan(1);
  });

  it("E42: one atomic unit alone over the limit is refused naming the unit, never truncated", () => {
    const r = planRequests(job([atom(0), atom(1, "y".repeat(5000)), atom(2)]), limits());
    expect(r.ok).toBe(false);
    if (r.ok || r.kind !== "unit-too-large") throw new Error("expected unit-too-large");
    expect(r.unitIndex).toBe(1);
    expect(r.message).toContain("unit 1");
    expect(r.message).toContain("q1");
  });

  it("E43: a plan over maxRequests is refused with the needed count", () => {
    const r = planRequests(job([0, 1, 2, 3, 4, 5].map((i) => atom(i, "z".repeat(2500)))), limits({ maxRequests: 2 }));
    if (r.ok || r.kind !== "too-many-requests") throw new Error("expected too-many-requests");
    expect(r.needed).toBe(6);
    expect(r.message).toContain("6");
  });

  it("caps questions per request at maxQuestionsPerRequest", () => {
    const plan = planRequests(job([0, 1, 2, 3, 4].map((i) => atom(i, "s"))), limits({ maxQuestionsPerRequest: 2 }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.map((r) => Object.keys(r.questions).length)).toEqual([2, 2, 1]);
  });

  it("sends each text unit alone and never packs atomic units across it", () => {
    const text = { kind: "text" as const, state: "file body", questions: { t: noul("T?") } };
    const plan = planRequests({ sharedState: null, units: [atom(0, "s"), text, atom(1, "s"), atom(2, "s")], unsplittable: {} }, limits());
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.map((r) => r.units.length)).toEqual([1, 1, 2]);
  });

  it("counts the shared state against every request", () => {
    const r = planRequests(job([atom(0, "s")], "e".repeat(4000)), limits());
    expect(r.ok).toBe(false);
  });

  it("fails fast on bad limits", () => {
    expect(() => planRequests(job([atom(0)]), limits({ contextTokens: 0 }))).toThrow(/contextTokens/);
    expect(() => planRequests(job([atom(0)]), limits({ maxRequests: 0 }))).toThrow(/maxRequests/);
  });

});


describe("planRequests text-unit chunking (L2-19)", () => {
  const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1} ${"z".repeat(40)}`).join("\n");
  const textUnit = (state: unknown) => ({ kind: "text" as const, state, questions: { t: noul("T?"), u: noul("U?") } });
  const big = limits({ contextTokens: 5000 });

  it("E114: a text unit over chunkChars becomes one request per chunk, keys suffixed, line ranges kept", () => {
    const plan = planRequests({ sharedState: null, units: [textUnit(body)], unsplittable: {} }, { ...big, chunkChars: 1000 });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(2);
    const infos = plan.requests.map((r) => chunkOf(r.units[0]!)!);
    expect(infos.map((c) => c.index)).toEqual(plan.requests.map((_, i) => i + 1));
    expect(infos[0]).toMatchObject({ source: 0, from: 1, count: plan.requests.length, keys: { "t#c1": "t", "u#c1": "u" } });
    expect(Object.keys(plan.requests[1]!.questions)).toEqual(["t#c2", "u#c2"]);
    expect(infos.at(-1)!.to).toBe(60);
    expect(plan.requests.every((r) => (r.state.units[0] as string).length <= 1000)).toBe(true);
  });

  it("leaves a text unit that fits untouched, with no chunk info", () => {
    const plan = planRequests({ sharedState: null, units: [textUnit("short")], unsplittable: {} }, big);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests[0]!.units[0]!.questions).toHaveProperty("t");
    expect(chunkOf(plan.requests[0]!.units[0]!)).toBeUndefined();
  });

  it("E116: a JSON state entry larger than one chunk is refused naming the key", () => {
    const r = planRequests({ sharedState: null, units: [textUnit({ ok: "s", huge: "h".repeat(1500) })], unsplittable: {} }, { ...big, chunkChars: 1000 });
    if (r.ok || r.kind !== "state-entry-too-large") throw new Error("expected state-entry-too-large");
    expect(r.key).toBe("huge");
    expect(r.message).toContain("huge");
  });

  it("splits a JSON state into groups of whole entries, one request each", () => {
    const state = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, "v".repeat(400)]));
    const plan = planRequests({ sharedState: null, units: [textUnit(state)], unsplittable: {} }, { ...big, chunkChars: 1000 });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(1);
    expect(Object.assign({}, ...plan.requests.map((r) => r.state.units[0] as object))).toEqual(state);
    expect(chunkOf(plan.requests[0]!.units[0]!)!.from).toBeUndefined();
  });

  it("refuses a chunk-chars outside 1000-90000", () => {
    expect(() => planRequests(job([atom(0)]), limits({ chunkChars: 500 }))).toThrow(/chunk-chars/);
  });

  it("a chunk that still does not fit the model at 1000 chars is refused as unit-too-large, never cut further", () => {
    const r = planRequests({ sharedState: null, units: [textUnit("z".repeat(200000))], unsplittable: {} }, limits({ contextTokens: 300, chunkChars: 90000 }));
    if (r.ok || r.kind !== "unit-too-large") throw new Error("expected unit-too-large");
  });
});


describe("planRequests chunk sizing and chunk info (L2-19 review)", () => {
  const unitOf = (state: unknown) => ({ kind: "text" as const, state, questions: { t: noul("T?") } });
  const ctx = (n: number) => limits({ contextTokens: n });
  const rebuild = (texts: string[]): string => texts.reduce((acc, c) => {
    for (let k = 500; k >= 0; k--) if (acc.endsWith(c.slice(0, k))) return acc + c.slice(k);
    return acc + c;
  });

  it("1: 40000 CJK chars (about 40000 tokens) in a 32000-token context are chunked, not refused, and nothing is lost", () => {
    const text = Array.from({ length: 40000 }, (_, i) => String.fromCodePoint(0x4e00 + (i % 20000))).join("");
    const plan = planRequests({ sharedState: null, units: [unitOf(text)], unsplittable: {} }, ctx(32000));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(1);
    plan.requests.forEach((r) => expect(r.tokens).toBeLessThanOrEqual(32000));
    expect(rebuild(plan.requests.map((r) => r.state.units[0] as string))).toBe(text);
  });

  it("1: an ASCII unit under chunkChars whose shared state fills most of the context is chunked, not refused", () => {
    const plan = planRequests({ sharedState: "s".repeat(80000), units: [unitOf("a".repeat(50000))], unsplittable: {} }, ctx(32000));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(1);
    plan.requests.forEach((r) => expect(r.tokens).toBeLessThanOrEqual(32000));
  });

  it("1: chunkChars stays an upper bound when everything fits", () => {
    const plan = planRequests({ sharedState: null, units: [unitOf("a".repeat(5000))], unsplittable: {} }, { ...ctx(32000), chunkChars: 2000 });
    if (!plan.ok) throw new Error(plan.message);
    plan.requests.forEach((r) => expect((r.state.units[0] as string).length).toBeLessThanOrEqual(2000));
  });

  it("1: when even 1000-char chunks do not fit the unit is refused", () => {
    const r = planRequests({ sharedState: null, units: [unitOf("字".repeat(5000))], unsplittable: {} }, ctx(700));
    if (r.ok || r.kind !== "unit-too-large") throw new Error("expected unit-too-large");
  });

  it("3: chunk info survives a renumber that builds fresh unit objects", () => {
    const job: SplitJob = { sharedState: null, unsplittable: {}, units: [unitOf("q".repeat(3000))], renumber: (units) => units.map((u) => ({ kind: u.kind, state: u.state, questions: u.questions })) };
    const plan = planRequests(job, { ...ctx(5000), chunkChars: 1000 });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(1);
    plan.requests.forEach((r, i) => expect(chunkOf(r.units[0]!)).toMatchObject({ index: i + 1 }));
  });

  it("4: a JSON array group records the original indices of its entries, an object group its original keys", () => {
    const arr = Array.from({ length: 6 }, (_, i) => "v".repeat(400) + i);
    const plan = planRequests({ sharedState: null, units: [unitOf(arr)], unsplittable: {} }, { ...ctx(5000), chunkChars: 1000 });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.map((r) => chunkOf(r.units[0]!)!.entries).flat()).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(chunkOf(plan.requests[1]!.units[0]!)!.entries![0]).not.toBe("0");
    const obj = Object.fromEntries(arr.map((v, i) => [`k${i}`, v]));
    const p2 = planRequests({ sharedState: null, units: [unitOf(obj)], unsplittable: {} }, { ...ctx(5000), chunkChars: 1000 });
    if (!p2.ok) throw new Error(p2.message);
    expect(p2.requests.map((r) => chunkOf(r.units[0]!)!.entries).flat()).toEqual(Object.keys(obj));
  });

  it("6: a caller question key containing #c and digits is refused naming the key", () => {
    const r = planRequests({ sharedState: null, unsplittable: {}, units: [{ kind: "text", state: "x", questions: { "q#c2": noul("Q?") } }] }, ctx(5000));
    if (r.ok || r.kind !== "reserved-question-key") throw new Error("expected reserved-question-key");
    expect(r.message).toContain("q#c2");
    expect(r.message).toContain("#c");
    const u = planRequests({ sharedState: null, unsplittable: { "z#c10": noul("Z?") }, units: [atom(0, "s")] }, ctx(5000));
    expect(u.ok === false && u.kind === "reserved-question-key").toBe(true);
  });
});


describe("L2-01 review fixes", () => {
  it("throws naming the key and both unit indexes when two units share a question key", () => {
    const dup = [atom(0, "s"), atom(1, "s"), { ...atom(2, "s"), questions: { q0: noul("Again?") } }];
    expect(() => planRequests(job(dup), limits())).toThrow(/"q0".*unit 0.*unit 2/);
  });

  it("the plan never under-counts: the serialized request body fits r.tokens and the context, for ASCII, quotes and non-ASCII text", () => {
    const mixed = (i: number) => ({ kind: "atomic" as const, state: i % 2 ? "he said \"hi\" ".repeat(60) : { text: "日本語".repeat(40) }, questions: { [`q${i}`]: noul(`Is "claim" ${i} true?`), [`r${i}`]: noul("日本語?") } });
    for (const lim of [300, 500, 700, 1000]) {
      const plan = planRequests(job([0, 1, 2, 3, 4, 5, 6, 7].map(mixed)), limits({ contextTokens: lim }));
      if (!plan.ok) continue;
      for (const r of plan.requests) {
        const real = estimateTokens(JSON.stringify({ state: r.state, questions: r.questions }));
        expect(real).toBeLessThanOrEqual(r.tokens);
        expect(r.tokens).toBeLessThanOrEqual(lim);
      }
    }
    // The loop must have planned at least one multi-unit request somewhere, or it proved nothing.
    const p = planRequests(job([0, 1, 2, 3, 4, 5, 6, 7].map(mixed)), limits({ contextTokens: 1000 }));
    if (!p.ok) throw new Error(p.message);
    expect(p.requests.some((r) => r.units.length > 1)).toBe(true);
  });

  it("a unit with more questions than maxQuestionsPerRequest gets its own kind and a question-count message", () => {
    const u = { kind: "atomic" as const, state: "s", questions: { a: noul("A?"), b: noul("B?"), c: noul("C?") } };
    const r = planRequests({ sharedState: null, units: [atom(0, "s"), u], unsplittable: {} }, limits({ maxQuestionsPerRequest: 2 }));
    if (r.ok || r.kind !== "unit-too-many-questions") throw new Error("expected unit-too-many-questions");
    expect(r.unitIndex).toBe(1);
    expect(r.message).toMatch(/3 questions.*limit of 2/);
    expect(r.message).not.toMatch(/tokens/);
  });

  it("refuses a job with no questions, in the wording of the request-shape check", () => {
    expect(() => planRequests(job([]), limits())).toThrow(/no questions, it needs at least 1 question/);
    expect(() => planRequests({ sharedState: null, units: [{ kind: "atomic", state: "s", questions: {} }], unsplittable: {} }, limits())).toThrow(/no questions/);
  });

  it("envelopeTokens is a plain number the limits may set", () => {
    const plan = planRequests(job([atom(0, "s")]), limits({ envelopeTokens: 100 }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests[0]!.tokens).toBeGreaterThanOrEqual(100);
  });

  it("refuses a unit whose state is undefined, by name, instead of under-counting it", () => {
    const u = { kind: "atomic" as const, state: undefined, questions: { z: noul("Z?") } };
    expect(() => planRequests(job([atom(0, "s"), u as never]), limits())).toThrow(/unit 1.*state is undefined/);
  });
});

const claim = (i: number) => ({ kind: "atomic" as const, state: { claim: `c${i}` }, questions: { [`k${i}`]: noul(`Is claims[${i}] supported?`) } });
// Rewrites claims[n] to the position inside the chunk that starts at `offset`.
const renumberClaims = (units: SplitJob["units"], offset: number) => units.map((u) => ({ ...u, questions: Object.fromEntries(Object.entries(u.questions).map(([k, q]) => [k, { ...q, instructions: q.instructions.replace(/claims\[(\d+)\]/g, (_m, n: string) => `claims[${Number(n) - offset}]`) }])) }));

describe("L2-02 unsplittable and renumber", () => {
  it("puts the unsplittable question and every unit in one request", () => {
    const plan = planRequests({ sharedState: "ev", units: [0, 1, 2, 3].map((i) => atom(i, "s".repeat(400))), unsplittable: { overall: noul("Overall?") } }, limits({ contextTokens: 2000 }));
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests).toHaveLength(1);
    expect(Object.keys(plan.requests[0]!.questions)).toEqual(["q0", "q1", "q2", "q3", "overall"]);
    expect(plan.requests[0]!.units).toHaveLength(4);
  });

  it("E44: unsplittable question plus units over one request is refused, even though the units alone would split fine", () => {
    const units = [0, 1, 2, 3, 4].map((i) => atom(i));
    expect(planRequests(job(units), limits()).ok).toBe(true);
    const r = planRequests({ sharedState: "evidence", units, unsplittable: { overall: noul("Overall?") } }, limits());
    if (r.ok || r.kind !== "unsplittable-too-large") throw new Error("expected unsplittable-too-large");
    expect(r.message).toContain("overall");
  });

  it("an unsplittable-only job (no units) plans one request", () => {
    const plan = planRequests({ sharedState: "page", units: [], unsplittable: { a: noul("A?"), b: noul("B?") } }, limits());
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests).toHaveLength(1);
    expect(Object.keys(plan.requests[0]!.questions)).toEqual(["a", "b"]);
  });

  it("E45: renumber is applied per chunk with the chunk offset, and toGlobalIndex maps local positions back", () => {
    const j: SplitJob = { sharedState: "ev", units: [0, 1, 2, 3, 4, 5].map((i) => ({ ...claim(i), state: { claim: "x".repeat(1600) } })), unsplittable: {}, renumber: renumberClaims };
    const plan = planRequests(j, limits());
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.requests.length).toBeGreaterThan(1);
    for (const r of plan.requests) {
      r.units.forEach((u, local) => {
        const q = Object.values(u.questions)[0]!;
        expect(q.instructions).toBe(`Is claims[${local}] supported?`);
        expect(Object.keys(u.questions)[0]).toBe(`k${toGlobalIndex(r, local)}`);
      });
      expect(Object.keys(r.questions)).toEqual(r.units.map((_u, local) => `k${r.offset + local}`));
    }
    expect(() => toGlobalIndex(plan.requests[0]!, plan.requests[0]!.units.length)).toThrow(/outside/);
  });

  it("E28: a renumber that changes question keys or drops units is rejected", () => {
    const bad = (f: (u: SplitJob["units"]) => SplitJob["units"]) => planRequests({ sharedState: null, units: [claim(0), claim(1)], unsplittable: {}, renumber: (u) => f(u) }, limits());
    expect(() => bad((u) => u.map((x) => ({ ...x, questions: { renamed: noul("R?") } })))).toThrow(/question keys/);
    expect(() => bad((u) => u.slice(1))).toThrow(/units/);
  });
});


const model = (o: Partial<DecisionsModel> = {}): DecisionsModel => ({ id: "typesafe/jev-1.13", canonicalSlug: "typesafe/jev-1.13-20260917", contextTokens: 64000, promptUsdPerM: 0.04, outputModalities: ["decisions"], systemOne: true, ...o });
const alias = model({ id: "~typesafe/jev-latest", canonicalSlug: "~typesafe/jev-latest", aliasTarget: "typesafe/jev-1.13", contextTokens: null });
const endpoints = (...max: (number | null)[]) => JSON.stringify({ data: { endpoints: max.map((m) => ({ max_prompt_tokens: m })) } });
const profile = { max_requests_per_call: 8, concurrency: 8 };

describe("L2-03 modelLimits", () => {
  it("reads the context from the catalog model and the rest from the profile", () => {
    const l = modelLimits({ resolved: resolveModel("typesafe/jev-1.13", [model()]), profile });
    expect(l).toEqual({ contextTokens: 64000, envelopeTokens: ENVELOPE_TOKENS, maxRequests: 8, concurrency: 8 });
  });

  it("takes the smaller of the catalog context and the endpoint prompt limit (measured: catalog 64000, endpoint 32000)", () => {
    const l = modelLimits({ resolved: resolveModel("typesafe/jev-1.13", [model()]), endpointPromptLimit: endpointPromptLimit(endpoints(32000, 40000)), profile });
    if ("ok" in l) throw new Error(l.message);
    expect(l.contextTokens).toBe(32000);
  });

  it("an alias takes the limits of its target, never its own null", () => {
    const l = modelLimits({ resolved: resolveModel("~typesafe/jev-latest", [alias, model()]), profile });
    if ("ok" in l) throw new Error(l.message);
    expect(l.contextTokens).toBe(64000);
  });

  it("E18: catalog context 0 (null) without a profile context_tokens is refused; with one it is used", () => {
    const resolved = resolveModel("typesafe/jev-1.13", [model({ contextTokens: null })]);
    const r = modelLimits({ resolved, profile });
    if (!("ok" in r) || r.kind !== "no-context-limit") throw new Error("expected no-context-limit");
    expect(r.message).toMatch(/context_tokens/);
    const l = modelLimits({ resolved, profile: { ...profile, context_tokens: 20000 } });
    if ("ok" in l) throw new Error(l.message);
    expect(l.contextTokens).toBe(20000);
  });

  it("passes maxQuestionsPerRequest through and rejects a bad profile context_tokens", () => {
    const resolved = resolveModel("typesafe/jev-1.13", [model()]);
    const l = modelLimits({ resolved, profile, maxQuestionsPerRequest: 19 });
    if ("ok" in l) throw new Error(l.message);
    expect(l.maxQuestionsPerRequest).toBe(19);
    expect(() => modelLimits({ resolved, profile: { ...profile, context_tokens: 0 } })).toThrow(/context_tokens/);
  });

  it("the limits it returns drive planRequests", () => {
    const l = modelLimits({ resolved: resolveModel("typesafe/jev-1.13", [model()]), endpointPromptLimit: 1000, profile });
    if ("ok" in l) throw new Error(l.message);
    expect(planRequests(job([0, 1, 2, 3, 4].map((i) => atom(i))), l)).toMatchObject({ ok: true });
  });
});


describe("review round 2", () => {
  it("plan §4/§8: the profile context_tokens is ignored while the catalog reports a context", () => {
    const l = modelLimits({ resolved: resolveModel("typesafe/jev-1.13", [model()]), endpointPromptLimit: 32000, profile: { ...profile, context_tokens: 10000 } });
    if ("ok" in l) throw new Error(l.message);
    expect(l.contextTokens).toBe(32000);
  });

  it("a catalog context of 0 counts as none; the override is then capped by a known endpoint limit", () => {
    const resolved = resolveModel("typesafe/jev-1.13", [model({ contextTokens: 0 })]);
    expect(modelLimits({ resolved, profile })).toMatchObject({ ok: false, kind: "no-context-limit" });
    const l = modelLimits({ resolved, endpointPromptLimit: 32000, profile: { ...profile, context_tokens: 64000 } });
    if ("ok" in l) throw new Error(l.message);
    expect(l.contextTokens).toBe(32000);
  });

  it("throws naming the profile field when max_requests_per_call or concurrency is not a positive integer", () => {
    const resolved = resolveModel("typesafe/jev-1.13", [model()]);
    expect(() => modelLimits({ resolved, profile: { ...profile, max_requests_per_call: 0 } })).toThrow(/max_requests_per_call/);
    expect(() => modelLimits({ resolved, profile: { ...profile, concurrency: 1.5 } })).toThrow(/concurrency/);
  });

  it("E44: an unsplittable unit-and-question overflow of the question cap has its own kind", () => {
    const r = planRequests({ sharedState: null, units: [atom(0, "s"), atom(1, "s")], unsplittable: { u: noul("U?") } }, limits({ maxQuestionsPerRequest: 2 }));
    if (r.ok || r.kind !== "unsplittable-too-many-questions") throw new Error("expected unsplittable-too-many-questions");
    expect(r.message).toMatch(/3 questions.*limit of 2/);
  });

  it("E44: the unsplittable question text counts against the size limit", () => {
    const r = planRequests({ sharedState: null, units: [atom(0, "s")], unsplittable: { overall: noul("Overall? ".repeat(400)) } }, limits());
    if (r.ok || r.kind !== "unsplittable-too-large") throw new Error("expected unsplittable-too-large");
  });

  it("a renumber that makes a request exceed the limit is a refusal with the offset, not a throw", () => {
    const grow = (units: SplitJob["units"]) => units.map((u) => ({ ...u, questions: Object.fromEntries(Object.entries(u.questions).map(([k, q]) => [k, { ...q, instructions: q.instructions + "y".repeat(5000) }])) }));
    const r = planRequests({ sharedState: null, units: [claim(0)], unsplittable: {}, renumber: grow }, limits());
    if (r.ok || r.kind !== "request-too-large") throw new Error("expected request-too-large");
    expect(r.offset).toBe(0);
  });

  it("throws naming sharedState when it is undefined (JSON would drop it)", () => {
    expect(() => planRequests({ sharedState: undefined, units: [atom(0, "s")], unsplittable: {} }, limits())).toThrow(/sharedState is undefined/);
  });
});
