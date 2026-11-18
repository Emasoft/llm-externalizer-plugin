// TRDD-1L9VMEY7: the local-only classifier profile local-decision (api mlx-decision-local) and the rule that no remote-only
// classifier profile may run. The decider is replaced only through the existing seams (RunDeps.fetch / PingDeps.fetch and
// localFallbackDeps, as local-decider-remote-error.test.ts does); its replies are the real captured System One answers of each spec
// (__fixtures__/o4), served as the decider reply shape. No mock of the code under test, no network: any URL that is not the fake
// decider is recorded and answered 599, and the tests assert that no openrouter.ai URL was asked.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinLocalDecisionProfile, localsPlatformSupported, remoteOnlyClassifierRefusal, validateClassifierProfile, validateProfile, type Profile } from "../config.js";
import { replayFixture, syntheticResponse, type RecordedReply } from "./l0/test-fetch.js";
import type { GlobalFetch } from "./l0/transport.js";
import { __resetLocalFallbackForTests } from "./l2/local-fallback.js";
import { DECISION_SPECS } from "./catalog/index.js";
import { runDecision, type RunDeps } from "./run-decision.js";
import { runPing, type PingDeps } from "./commands/ping.js";

const DECIDER = "http://127.0.0.1:8124";
const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`./__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

const diff = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
// The same inputs as catalog/live-capture.test.ts (the ones the o4 replies were captured for), so each captured answer fits its build.
const INPUTS: Record<string, unknown> = {
  verify: { claims: [{ text: "a" }], evidence: [{ text: "b" }, { text: "c" }] },
  screen: { text: "hello", purpose: "p" },
  filter: { question: "q", items: [{ text: "a" }] },
  label: { items: [{ text: "a" }], classes: [{ id: "a" }, { id: "b" }] },
  rank: { query: "q", candidates: [{ text: "a" }] },
  find: { query: "q", items: [{ text: "a" }, { text: "b" }] },
  decide: { decision: "Choose the candidate matching evidence", evidence: "option 3 matches", priorities: "match the evidence", candidates: Array.from({ length: 10 }, (_, i) => ({ id: `opt${i}`, description: `option ${i}` })), requirements: ["match evidence"] },
  compare: { passage_a: "alpha", passage_b: "beta", aspects: ["tone"] },
  extract: { document: "Price 10 EUR, old 12 EUR", fields: [{ id: "price", pattern: "[0-9]+ EUR", description: "the price" }] },
  audit: { source: "the source text", records: [{ request: "the name", value: "Ann" }] },
  review: { diff, request: "change a to b" },
  check: { preset: "invariant-check", invariants: [{ text: "i" }], before: "x", after: "y" },
  findings: { task: "t", findings: [{ file: "f.ts", line: 1, text: "bug" }], sources: [{ file: "f.ts", text: "a\nb" }] },
  "test-output": { log: "ok\nFAIL x\nok", matches: [2] },
  requirements: { prompt: "the colors are horrible. let's improve it a little. the loading screen background should be blue. change it and rebuild. then open the web site in chrome for me to see.", context: "We implemented the loading screen, but we need to improve the style. Let me see how is it now." },
  "rule-check": { phrase: "the loading screen background should be blue", rules: [{ id: "r1", text: "make the background color of the loading dialog of a shade of blue" }, { id: "r2", text: "the background of the load panel must not be transparent." }, { id: "u1", text: "every API response must include a request id header" }, { id: "u2", text: "the settings page must be reachable from the main menu" }], context: "We implemented the loading screen, but we need to improve the style. Let me see how is it now." },
};

const LOCAL: Profile = builtinLocalDecisionProfile().profile;
const REMOTE = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$OPENROUTER_API_KEY" } as unknown as Profile; // ubs:ignore env-var reference, not a secret

let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  __resetLocalFallbackForTests();
  tmp = mkdtempSync(join("/tmp", "llm-ext-local-decision-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, LLM_EXT_GOVERNOR_ENABLED: process.env.LLM_EXT_GOVERNOR_ENABLED, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.LLM_EXT_GOVERNOR_ENABLED = "false";
  // WHY unset: the local-only profile must work with no key in the environment.
  delete process.env.OPENROUTER_API_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake decider: /health says elephant-1 is loaded; a POST answers with `answer(questions, state)` or the given HTTP reply. Every other URL is recorded. */
function deciderFetch(answer: (questions: Record<string, unknown>, state: unknown) => Response): { fetch: GlobalFetch; others: string[]; posts: number } {
  const state = { others: [] as string[], posts: 0 };
  const fetch: GlobalFetch = async (url, init) => {
    if (url.startsWith(DECIDER)) {
      if (url.endsWith("/health")) return new Response(JSON.stringify({ status: "ok", model: "elephant-1", loaded: ["elephant-1"] }), { status: 200 });
      state.posts++;
      const body = JSON.parse(String(init.body)) as { state: unknown; questions: Record<string, unknown> };
      return answer(body.questions, body.state);
    }
    state.others.push(url);
    return syntheticResponse(599, "not reachable in this test", {});
  };
  return { fetch, get others() { return state.others; }, get posts() { return state.posts; } };
}
const reply = (answers: Record<string, unknown>): Response => new Response(JSON.stringify({ model: "elephant-1", answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 });
const seams = (fetch: GlobalFetch, localFallback: unknown = { url: DECIDER, requestTimeoutMs: 20_000, attemptTimeoutMs: 5000, startTimeoutMs: 1000, maxAttempts: 1 }): Omit<RunDeps, "settings"> => ({
  fetch,
  catalogOptions: { path: join(tmp, "catalog.json") },
  sigint: new EventEmitter(),
  stderr: () => undefined,
  localFallback,
  localFallbackDeps: { discover: async () => [{ pid: 4242, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
});
const settingsWith = (profiles: Record<string, Profile>, active_classifier?: string) => ({ active: undefined, active_classifier, profiles });

describe("TRDD-1L9VMEY7: validation of a local-only classifier profile", () => {
  it("the built-in local-decision profile is valid, with no model, key or endpoint", () => {
    expect(LOCAL).toEqual({ "profile-type": "classifier", api: "mlx-decision-local", context_tokens: 16384, max_requests_per_call: 64 });
    expect(validateClassifierProfile("local-decision", LOCAL)).toEqual([]);
    expect(validateProfile("local-decision", LOCAL).valid).toBe(true);
  });

  it.each(["model", "api_key", "endpoint", "provider"])("refuses %s on api mlx-decision-local, naming the key", (key) => {
    const value = key === "provider" ? { order: ["x"] } : key === "api_key" ? "$OPENROUTER_API_KEY" : key === "endpoint" ? "decisions" : "typesafe/jev-1.13";
    const errors = validateClassifierProfile("p", { ...LOCAL, [key]: value } as unknown as Profile);
    expect(errors.some((e) => e.includes(`${key} does not apply to api: mlx-decision-local`))).toBe(true);
  });

  it("an unknown api names both accepted values; a remote profile still needs a model", () => {
    expect(validateClassifierProfile("p", { ...LOCAL, api: "other" } as unknown as Profile)).toContain("Profile 'p': a classifier profile requires api: openrouter-remote or api: mlx-decision-local, got 'other'");
    expect(validateClassifierProfile("p", { "profile-type": "classifier", api: "openrouter-remote" } as unknown as Profile)).toContain("Profile 'p': missing required field: model");
  });
});

describe("TRDD-1L9VMEY7: no remote-only classifier profile (classify launcher rule)", () => {
  const off = { enabled: false };
  it("a remote classifier profile with local_fallback.enabled false is refused, naming the rule and local-decision", () => {
    const msg = remoteOnlyClassifierRefusal({ active_classifier: "or-jev", profiles: { "or-jev": REMOTE }, local_fallback: off }, undefined);
    expect(msg).toContain("a remote-only classifier profile is not allowed");
    expect(msg).toContain("--profile local-decision");
    expect(remoteOnlyClassifierRefusal({ active_classifier: "local-decision", profiles: { "or-jev": REMOTE }, local_fallback: off }, "or-jev")).toContain("profile 'or-jev'");
  });
  it("is silent for a local-only profile (its own fallback), an enabled or absent section, and a non-classifier profile", () => {
    expect(remoteOnlyClassifierRefusal({ active_classifier: "local-decision", profiles: { "local-decision": LOCAL }, local_fallback: off }, undefined)).toBeUndefined();
    expect(remoteOnlyClassifierRefusal({ active_classifier: "or-jev", profiles: { "or-jev": REMOTE }, local_fallback: { enabled: true } }, undefined)).toBeUndefined();
    expect(remoteOnlyClassifierRefusal({ active_classifier: "or-jev", profiles: { "or-jev": REMOTE } }, undefined)).toBeUndefined();
    const chat = { "profile-type": "free", mode: "remote", api: "openrouter-remote", model: "m" } as unknown as Profile;
    expect(remoteOnlyClassifierRefusal({ profiles: { c: chat }, local_fallback: off }, "c")).toBeUndefined();
  });
});

describe("TRDD-1L9VMEY7: every classify action answers through the local decider only", () => {
  for (const spec of DECISION_SPECS) {
    it(`${spec.id}: exit 0, answered by elephant-1, no request to openrouter.ai, cost 0`, async () => {
      const captured = (JSON.parse(fx("o4", spec.id).body) as { answers: Record<string, unknown> }).answers;
      const d = deciderFetch((q) => reply(Object.fromEntries(Object.keys(q).map((k) => [k, captured[k]]))));
      const out = await runDecision(spec, { input: INPUTS[spec.id], profileFlag: "local-decision" }, { settings: settingsWith({ "local-decision": LOCAL, "or-jev": REMOTE }, "or-jev"), ...seams(d.fetch) });
      expect(out.exitCode, `${out.cause ?? ""} ${out.text ?? ""}`).toBe(0);
      expect(d.posts).toBeGreaterThan(0);
      expect(d.others.filter((u) => u.includes("openrouter.ai"))).toEqual([]);
      expect(JSON.stringify(out.envelope!.decision)).not.toContain("invalid_response");
      expect(JSON.stringify(out.envelope)).toContain("elephant-1");
      expect(out.envelope!.warnings.map((w) => w.code)).not.toContain("local_decider");
      expect(out.receipt!.costUsd).toBe(0);
    });
  }

  it("local_fallback.enabled false does not disable the local-only profile (it is its own fallback)", async () => {
    const d = deciderFetch((q) => reply(Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: 0.9 }]))));
    const { spec } = await import("./catalog/filter.js");
    const out = await runDecision(spec, { input: INPUTS.filter }, { settings: settingsWith({ "local-decision": LOCAL }, "local-decision"), ...seams(d.fetch, { url: DECIDER, enabled: false, startTimeoutMs: 1000, maxAttempts: 1 }) });
    expect(out.exitCode, out.cause).toBe(0);
    expect(d.posts).toBe(1);
  });

  it("the decider 422 ends the run with exit 4 and its text verbatim; nothing remote is tried", async () => {
    const text = "the question with its state needs 60103 tokens; the limit is 16384 and input is not cut";
    const d = deciderFetch(() => new Response(JSON.stringify({ error: { message: text, type: "invalid_request_error" } }), { status: 422 }));
    const { spec } = await import("./catalog/filter.js");
    const out = await runDecision(spec, { input: INPUTS.filter, profileFlag: "local-decision" }, { settings: settingsWith({ "local-decision": LOCAL }), ...seams(d.fetch) });
    expect(out.exitCode).toBe(4);
    expect(out.cause).toContain(text);
    // WHY one POST: the 422 over-limit is deterministic, so it is never retried (and the message says so).
    expect(d.posts).toBe(1);
    expect(out.cause).toContain("1 POST attempt, not retryable");
    expect(d.others).toEqual([]);
  });

  // TRDD-NL2012O9: a text item travels alone, and the l1 estimate plans it under the 16384 window; the decider counts it higher and refuses it with a 422, which used to end its question as "no answer".
  it("a text item the decider refuses with a 422 is cut again and answered from its pieces: exit 0, the item matched, nothing remote", async () => {
    // WHY lorem text and chars / 2: about 0.32 estimated tokens per char against the 0.5 this fake decider counts, so 39606 chars (about 12650 estimated) plan as ONE request that the decider (about 19800) refuses.
    const text = `${"lorem ipsum dolor ".repeat(2200)}NEEDLE`;
    const counted: number[] = [];
    const d = deciderFetch((q, state) => {
      const json = JSON.stringify(state);
      const tokens = Math.ceil(json.length / 2);
      counted.push(tokens);
      if (tokens > 16384) return new Response(JSON.stringify({ error: { message: `the question with its state needs ${tokens} tokens; the limit is 16384 and input is not cut`, type: "invalid_request_error" } }), { status: 422 });
      return reply(Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: json.includes("NEEDLE") ? 0.9 : 0.1 }])));
    });
    const { spec } = await import("./catalog/filter.js");
    const out = await runDecision(spec, { input: { question: "Does it mention a needle?", items: [{ id: "big", text }] }, profileFlag: "local-decision" }, { settings: settingsWith({ "local-decision": LOCAL }), ...seams(d.fetch) });
    expect(out.exitCode, `${out.cause ?? ""} ${out.text ?? ""}`).toBe(0);
    // the whole text first (refused), then pieces that each fit the decider
    expect(counted[0]).toBeGreaterThan(16384);
    expect(counted.length).toBeGreaterThan(2);
    expect(counted.slice(1).every((n) => n <= 16384)).toBe(true);
    const decision = out.envelope!.decision as { rows: { id: string; p: number }[]; invalid: unknown[] };
    expect(decision.invalid).toEqual([]);
    expect(decision.rows.map((r) => [r.id, r.p])).toEqual([["big", 0.9]]);
    expect(d.others).toEqual([]);
  });
  it("a split request whose piece the decider refuses names that piece reason and question count on stderr and in the warnings, not only \"answer missing from reply\"", async () => {
    // TRDD-1L9VMEY7: the decider refuses every multi-question request, then the second single-question piece, each with the measured 422 text.
    const refusal = (needed: number): Response => new Response(JSON.stringify({ error: { message: `the question with its state needs ${needed} tokens; the limit is 16384 and input is not cut`, type: "invalid_request_error" } }), { status: 422 });
    let singles = 0;
    const d = deciderFetch((q) => {
      if (Object.keys(q).length > 1) return refusal(20001);
      singles++;
      return singles === 2 ? refusal(16460) : reply(Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: 0.9 }])));
    });
    const lines: string[] = [];
    const { spec } = await import("./catalog/filter.js");
    // WHY propositions: atomic units are packed into one request (a text item travels alone), so the first POST holds several questions.
    const input = { propositions: Array.from({ length: 4 }, (_v, i) => ({ text: `claim ${i}` })) };
    const out = await runDecision(spec, { input, profileFlag: "local-decision" }, { settings: settingsWith({ "local-decision": LOCAL }), ...seams(d.fetch), stderr: (l) => lines.push(l) });
    const w = out.envelope!.warnings.filter((x) => x.code === "split_piece_failed");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("needs 16460 tokens; the limit is 16384");
    expect(w[0]!.message).toContain("a split piece of 1 question was not answered");
    expect(lines.filter((l) => l.includes("needs 16460 tokens; the limit is 16384"))).toHaveLength(1);
    // the keys of the failed piece still read as an omission in the envelope; the warning and the stderr line above are where the reason lives
    expect(JSON.stringify(out.envelope!.decision)).toContain("answer missing from reply");
  });
  it("a decider that is not running fails the run with its reason, exit 5, and no remote fallback", async () => {
    const d = deciderFetch(() => reply({}));
    const { spec } = await import("./catalog/filter.js");
    // WHY another port: nothing answers there (the fake decider listens on DECIDER only), and discovery finds no process either.
    const deps = { settings: settingsWith({ "local-decision": LOCAL }), ...seams(d.fetch, { url: "http://127.0.0.1:8199", requestTimeoutMs: 3000, attemptTimeoutMs: 2000, startTimeoutMs: 1000, maxAttempts: 1 }), localFallbackDeps: { discover: async () => [], singletonInstalled: () => false, platform: "darwin" } };
    const out = await runDecision(spec, { input: INPUTS.filter, profileFlag: "local-decision" }, deps as RunDeps);
    expect(out.exitCode).toBe(5);
    expect(out.cause).toContain("local decider");
    expect(d.others.filter((u) => u.includes("openrouter.ai"))).toEqual([]);
  });

  it("--estimate says the call is local and free and sends nothing", async () => {
    const d = deciderFetch(() => reply({}));
    const { spec } = await import("./catalog/filter.js");
    const out = await runDecision(spec, { input: INPUTS.filter, profileFlag: "local-decision", estimate: true }, { settings: settingsWith({ "local-decision": LOCAL }), ...seams(d.fetch) });
    expect(out.exitCode).toBe(0);
    expect(out.display).toContain("0 USD (local");
    expect(out.display).toContain("model: elephant-1");
    expect(JSON.parse(out.text!).estimate.local).toBe(true);
    expect(d.posts).toBe(0);
    expect(d.others).toEqual([]);
  });

  // A text big enough to need several requests: about 95k estimated tokens.
  const BIG = { question: "Does it mention a cat?", items: [{ id: "big", text: "lorem ipsum dolor sit amet ".repeat(11_000) }] };
  const estimateOf = (out: Awaited<ReturnType<typeof runDecision>>): { requests: number; input_tokens: number } => (JSON.parse(out.text!) as { estimate: { requests: number; input_tokens: number } }).estimate;

  it("a hand-written local-only profile without context_tokens plans with the decider limit constant and the local request cap", async () => {
    const d = deciderFetch(() => reply({}));
    const { spec } = await import("./catalog/filter.js");
    const bare = { "profile-type": "classifier", api: "mlx-decision-local" } as unknown as Profile;
    const wide = { ...bare, context_tokens: 64000 } as unknown as Profile;
    const bareOut = await runDecision(spec, { input: BIG, profileFlag: "mine", estimate: true }, { settings: settingsWith({ mine: bare }), ...seams(d.fetch) });
    const wideOut = await runDecision(spec, { input: BIG, profileFlag: "mine", estimate: true }, { settings: settingsWith({ mine: wide }), ...seams(d.fetch) });
    expect(bareOut.exitCode, bareOut.cause).toBe(0);
    expect(wideOut.exitCode, wideOut.cause).toBe(0);
    // WHY more than 8: the plan is over the remote default cap and still accepted (local default 64).
    expect(estimateOf(bareOut).requests).toBeGreaterThan(8);
    expect(estimateOf(bareOut).requests).toBeGreaterThan(estimateOf(wideOut).requests);
    expect(d.posts).toBe(0);
  });

  // WHY skipIf: the clamp applies only where mlx-decision can run (macOS on Apple silicon); elsewhere the plan is unchanged.
  it.skipIf(!localsPlatformSupported())("a remote run with the local fallback on plans every request to fit the decider limit (more requests than with it off)", async () => {
    const { spec } = await import("./catalog/filter.js");
    const fetch: GlobalFetch = async (url) => {
      if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
      if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
      throw new Error(`unexpected request in a dry run: ${url}`);
    };
    const remote = { ...REMOTE, max_requests_per_call: 100 } as unknown as Profile;
    const run = (localFallback: unknown) => runDecision(spec, { input: BIG, profileFlag: "r", estimate: true }, { settings: settingsWith({ r: remote }), ...seams(fetch, localFallback) });
    const off = await run({ enabled: false });
    const on = await run(undefined);
    expect(off.exitCode, off.cause).toBe(0);
    expect(on.exitCode, on.cause).toBe(0);
    expect(estimateOf(on).requests).toBeGreaterThan(estimateOf(off).requests);
  });
});

describe("TRDD-1L9VMEY7: classify ping on the local-only profile", () => {
  const pingDeps = (fetch: GlobalFetch, stdout: string[], stderr: string[]): PingDeps => ({
    settings: settingsWith({ "local-decision": LOCAL }),
    fetch,
    sigint: new EventEmitter(),
    stdout: (t: string) => { stdout.push(t); },
    stderr: (l: string) => { stderr.push(l); },
    localFallback: { url: DECIDER, startTimeoutMs: 1000, maxAttempts: 1 },
    localFallbackDeps: { discover: async () => [{ pid: 4242, urls: [DECIDER] }], singletonInstalled: () => true, platform: "darwin" },
  });
  it("exits 0 with no key in the environment, one question to the decider, nothing remote", async () => {
    const d = deciderFetch(() => reply({ ping: { type: "noul", noul: 0.97 } }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await runPing([], "local-decision", pingDeps(d.fetch, stdout, stderr))).toBe(0);
    expect(stdout.join("\n")).toContain("key check: skipped");
    expect(stdout.join("\n")).toContain("decision call: ok (the local decider, no API key used; model elephant-1, answer 0.97");
    expect(d.posts).toBe(1);
    expect(d.others).toEqual([]);
  });
  it("--no-call asks nothing", async () => {
    const d = deciderFetch(() => reply({}));
    const stdout: string[] = [];
    expect(await runPing(["--no-call"], "local-decision", pingDeps(d.fetch, stdout, []))).toBe(0);
    expect(d.posts).toBe(0);
    expect(d.others).toEqual([]);
  });
});
