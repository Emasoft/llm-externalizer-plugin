// TRDD-O4MSZIG5: each registered spec run end to end on ONE real Jev reply, captured live from its own `build` (D12, D21) and sanitized like P-01; served through the GlobalFetch seam, no network.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile } from "../../config.js";
import { replayFixture, type RecordedReply } from "../l0/test-fetch.js";
import type { GlobalFetch } from "../l0/transport.js";
import { runDecision } from "../run-decision.js";
import { DECISION_SPECS } from "./index.js";

const fx = (dir: string, n: string): RecordedReply => JSON.parse(readFileSync(new URL(`../__fixtures__/${dir}/${n}.json`, import.meta.url), "utf8")) as RecordedReply;

const diff = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
// The inputs the capture script sent (scripts_dev/capture-o4mszig5.ts); a changed `build` that no longer asks the captured questions fails the key check below.
const INPUTS: Record<string, unknown> = {
  verify: { claims: [{ text: "a" }], evidence: [{ text: "b" }, { text: "c" }] },
  screen: { text: "hello", purpose: "p" },
  filter: { question: "q", items: [{ text: "a" }] },
  label: { items: [{ text: "a" }], classes: [{ id: "a" }, { id: "b" }] },
  rank: { query: "q", candidates: [{ text: "a" }] },
  find: { query: "q", items: [{ text: "a" }, { text: "b" }] },
  // WHY ten candidates: the one capture with more than 9 options (the recommendation question then has 13 options with the three fixed ones).
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

const KEY = "[REDACTED:openai-key]";
let tmp: string;
let prev: Record<string, string | undefined>;
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-o4-"));
  prev = { LLM_EXT_CONFIG_DIR: process.env.LLM_EXT_CONFIG_DIR, O4_TEST_KEY: process.env.O4_TEST_KEY };
  process.env.LLM_EXT_CONFIG_DIR = tmp;
  process.env.O4_TEST_KEY = KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(tmp, { recursive: true, force: true });
});

const profile = { "profile-type": "classifier", api: "openrouter-remote", model: "typesafe/jev-1.13", api_key: "$O4_TEST_KEY", max_attempts: 1, timeout_ms: 5000, concurrency: 2 } as unknown as Profile; // ubs:ignore env-var reference, not a secret

describe("TRDD-O4MSZIG5: every spec projects one real captured reply", () => {
  it("covers exactly the registered specs", () => {
    expect(Object.keys(INPUTS).sort()).toEqual(DECISION_SPECS.map((s) => s.id).sort());
  });

  for (const spec of DECISION_SPECS) {
    it(`${spec.id}: the live reply answers the questions its build asks and project reads it without an invalid row`, async () => {
      const reply = fx("o4", spec.id);
      const sent: Record<string, { criteria?: Record<string, unknown> }>[] = [];
      const fetch: GlobalFetch = async (url, init) => {
        if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
        if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
        sent.push((JSON.parse(String(init.body)) as { questions: Record<string, { criteria?: Record<string, unknown> }> }).questions);
        return replayFixture(reply);
      };
      const out = await runDecision(spec, { input: INPUTS[spec.id] }, {
        settings: { active: "c", active_classifier: "c", profiles: { c: profile } },
        fetch,
        catalogOptions: { path: join(tmp, "catalog.json") },
        sigint: new EventEmitter(),
        // WHY the local decider is OFF here: these tests pin a captured reply, and a local answer would hide it.
        // WHY off explicitly and not merely left out: an absent section means ENABLED by default, so a failing
        // remote call would reach — or start — the real 15 GB decider.
        localFallback: { enabled: false },
      });
      expect(out.exitCode, out.text).toBe(0);
      expect(sent).toHaveLength(1);
      // WHY key equality: an answer the build did not ask, or a question the reply does not answer, means build and the captured reply have drifted apart.
      expect(Object.keys(sent[0]!).sort()).toEqual(Object.keys((JSON.parse(reply.body) as { answers: object }).answers).sort());
      expect(JSON.stringify(out.envelope!.decision)).not.toContain("invalid_response");
      if (spec.id === "decide") expect(Math.max(...Object.values(sent[0]!).map((q) => Object.keys(q.criteria ?? {}).length))).toBeGreaterThan(9);
    });
  }
});

// TRDD-58CFBQHN: the help of every decision command lists --estimate (tools/definitions-classify.test.ts), so the dry run must really work for all of them, not only the three measured live. Through the one runner with the recorded catalog and no network: the estimate exits 0, prints "nothing was sent" and reaches no decisions endpoint.
// WHY a positive control per spec: "no decisions request" would also hold if the spy could never see one; the same input without estimate must send exactly one, which makes the zero meaningful.
describe("TRDD-58CFBQHN: --estimate works for every spec and sends no decisions request", () => {
  for (const spec of DECISION_SPECS) {
    it(`${spec.id}: the dry run exits 0, prints the estimate and sends no decisions request; the same input without it sends one`, async () => {
      const run = async (estimate: boolean) => {
        let decisions = 0;
        const fetch: GlobalFetch = async (url) => {
          if (url.includes("output_modalities=decisions")) return replayFixture(fx("p02", "models-decisions"));
          if (url.endsWith("/endpoints")) return replayFixture(fx("p02", "target-endpoints"));
          decisions++;
          return replayFixture(fx("o4", spec.id));
        };
        const out = await runDecision(spec, { input: INPUTS[spec.id], ...(estimate ? { estimate: true } : {}) }, {
          settings: { active: "c", active_classifier: "c", profiles: { c: profile } },
          fetch,
          catalogOptions: { path: join(tmp, "catalog.json") },
          sigint: new EventEmitter(),
          // WHY the local decider is OFF here: same reason as the capture above — this pins a captured reply.
          localFallback: { enabled: false },
        });
        return { out, decisions };
      };
      const dry = await run(true);
      expect(dry.out.exitCode, dry.out.text).toBe(0);
      expect(dry.decisions).toBe(0);
      expect(dry.out.display).toContain(`classify ${spec.id} --estimate: nothing was sent`);
      expect(dry.out.envelope).toBeUndefined();
      const real = await run(false);
      expect(real.decisions).toBe(1);
    });
  }
});
