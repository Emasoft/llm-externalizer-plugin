import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHistoryPath, readHistory, withUsageContext } from "../../usage-history.js";
import { loadDecisionsCatalog, type DecisionsModel } from "../l0/catalog.js";
import { parseDecisionsReply, type ReplyUsage } from "../l0/response.js";
import { replayFetch, replayFixture, syntheticResponse, type RecordedReply } from "../l0/test-fetch.js";
import { recordDecisionsUsage, replyCost, type ReplyCost } from "./usage.js";

const FIXTURES = fileURLToPath(new URL("../__fixtures__/", import.meta.url));
const fixture = (dir: string, name: string): RecordedReply =>
  JSON.parse(readFileSync(join(FIXTURES, dir, `${name}.json`), "utf8"));
// P-01 holds the captured replies; the ones with status 200 are the 79 success replies this card costs.
const successNames = readdirSync(join(FIXTURES, "p01"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .filter((n) => fixture("p01", n).status === 200);

let tmp: string;
let prevConfigDir: string | undefined;
beforeEach(() => {
  prevConfigDir = process.env.LLM_EXT_CONFIG_DIR;
  // WHY /tmp: getConfigDir() accepts only $HOME or /tmp paths, and os.tmpdir() (/var/folders on macOS) is refused.
  tmp = mkdtempSync(join("/tmp", "llm-ext-usage-"));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = prevConfigDir;
  rmSync(tmp, { recursive: true, force: true });
});

/** Every non-empty line the usage history has received so far. */
function readLines(): string[] {
  const p = getHistoryPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8").split("\n").filter((l) => l.length > 0);
}

/** A real success reply with usage.cost removed, as a reply without a cost looks on the wire. */
function replyWithoutCost(name: string): Response {
  const { usage, ...rest } = JSON.parse(fixture("p01", name).body);
  const { cost: _cost, ...usageNoCost } = usage;
  return syntheticResponse(200, JSON.stringify({ ...rest, usage: usageNoCost }));
}

/** The P-02 decisions catalog through the real loader and GlobalFetch seam; dropPriceOf blanks one entry pricing. */
async function loadCatalog(dropPriceOf?: string): Promise<DecisionsModel[]> {
  const rec = fixture("p02", "models-decisions");
  if (dropPriceOf !== undefined) {
    const body = JSON.parse(rec.body) as { data: { id: string; pricing?: unknown }[] };
    for (const m of body.data) if (m.id === dropPriceOf) delete m.pricing;
    rec.body = JSON.stringify(body);
  }
  return loadDecisionsCatalog({ fetch: replayFetch([rec]).fetch, path: join(tmp, "decisions-catalog-cache.json") });
}

describe("replyCost (D8, E12)", () => {
  it("keeps the usage.cost the reply carries and does not flag it as estimated", () => {
    expect(replyCost({ input_tokens: 340, output_tokens: 34, cost: 0.00001428 }, 0.042)).toEqual({
      costUsd: 0.00001428,
      cost_estimated: false,
    });
  });
  it("estimates 1000 input tokens at 0.042 USD per million as 0.000042, output tokens adding nothing", () => {
    const c = replyCost({ input_tokens: 1000, output_tokens: 5000 }, 0.042);
    expect(c.cost_estimated).toBe(true);
    expect(c.costUsd).toBeCloseTo(0.000042, 12);
  });
  it("refuses a reply with no usage.cost when the catalog has no prompt price, instead of recording it as free", () => {
    expect(() => replyCost({ input_tokens: 1, output_tokens: 1 }, null)).toThrow(/no prompt price/);
  });
});

describe("recordDecisionsUsage on the real P-01 success replies", () => {
  it("the 79 success replies keep their usage.cost, are not flagged, and each writes one history line", async () => {
    // Pinned on purpose: an added or lost fixture must be noticed. dec-multi3 (three answers in one reply) was added on 2026-10-10.
    expect(successNames).toHaveLength(79);
    const catalog = await loadCatalog();
    for (const n of successNames) {
      let got: ReplyCost | undefined;
      await parseDecisionsReply(replayFixture(fixture("p01", n)), (usage) => {
        got = recordDecisionsUsage({ usage, model: "~typesafe/jev-latest", catalog, durationMs: 1, endpoint: "decisions" });
      });
      expect(got).toEqual({ costUsd: JSON.parse(fixture("p01", n).body).usage.cost, cost_estimated: false });
    }
    expect(readLines()).toHaveLength(79);
  });
  it("synthetic: E12 the same 79 replies with usage.cost removed are estimated from input tokens times the catalog price and flagged", async () => {
    const catalog = await loadCatalog();
    for (const n of successNames) {
      let got: ReplyCost | undefined;
      await parseDecisionsReply(replyWithoutCost(n), (usage) => {
        got = recordDecisionsUsage({ usage, model: "~typesafe/jev-latest", catalog, durationMs: 1, endpoint: "decisions" });
      });
      expect(got?.cost_estimated).toBe(true);
      // The provider cost is the reference: the catalog price alone must reproduce it.
      expect(got?.costUsd).toBeCloseTo(JSON.parse(fixture("p01", n).body).usage.cost, 12);
    }
    expect(readLines()).toHaveLength(79);
  });
  it("E12: a reply with no usage.cost for a model whose catalog price is missing is refused and nothing is recorded", async () => {
    const catalog = await loadCatalog("typesafe/jev-1.13");
    await expect(
      parseDecisionsReply(replyWithoutCost("dec-choice3"), (usage) => {
        recordDecisionsUsage({ usage, model: "typesafe/jev-1.13", catalog, durationMs: 1, endpoint: "decisions" });
      }),
    ).rejects.toThrow(/no prompt price/);
    expect(readLines()).toEqual([]);
  });
  it("synthetic: a billed 200 reply is counted before its validation fails, and a reply with bad usage is not counted", async () => {
    const catalog = await loadCatalog();
    const billed = (usage: ReplyUsage) => {
      recordDecisionsUsage({ usage, model: "~typesafe/jev-latest", catalog, durationMs: 1, endpoint: "decisions" });
    };
    const blankModel = syntheticResponse(
      200,
      JSON.stringify({ model: " ", answers: {}, usage: { input_tokens: 10, output_tokens: 2, cost: 0.0000042 } }),
    );
    await expect(parseDecisionsReply(blankModel, billed)).rejects.toThrow(/missing or blank model/);
    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(" - SUCCESS - ");
    expect(lines[0]).toContain(" - $0.000004 - ");
    const badUsage = syntheticResponse(
      200,
      JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: "10", output_tokens: 2 } }),
    );
    await expect(parseDecisionsReply(badUsage, billed)).rejects.toThrow(/invalid usage/);
    expect(readLines()).toHaveLength(1);
  });
  it("withUsageContext: every request of one run is attributed to its tool and shares one op-id", async () => {
    const catalog = await loadCatalog();
    const f = fixture("p01", "dec-choice3");
    await withUsageContext({ tool: "classify", params: "", project: tmp }, async () => {
      for (let i = 0; i < 2; i++) {
        await parseDecisionsReply(replayFixture(f), (usage) => {
          recordDecisionsUsage({ usage, model: "~typesafe/jev-latest", catalog, durationMs: 1, endpoint: "decisions" });
        });
      }
    });
    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.includes(" - classify() - "))).toBe(true);
    const ops = lines.map((l) => /op-[0-9a-f]{8}/.exec(l)?.[0]);
    expect(ops[0]).toMatch(/^op-[0-9a-f]{8}$/);
    expect(ops[1]).toBe(ops[0]);
  });
});

describe("L1-10 endpoint field on decisions usage lines", () => {
  it("every decisions line carries its endpoint, and the history reader shows them as decisions calls", async () => {
    const catalog = await loadCatalog();
    for (const endpoint of ["decisions", "systemone"] as const) {
      await parseDecisionsReply(replayFixture(fixture("p01", "dec-choice3")), (usage) => {
        recordDecisionsUsage({ usage, model: "~typesafe/jev-latest", catalog, durationMs: 1, endpoint });
      });
    }
    const lines = readLines();
    expect(lines[0]).toMatch(/ - endpoint=decisions$/);
    expect(lines[1]).toMatch(/ - endpoint=systemone$/);
    expect(readHistory().map((e) => e.endpoint)).toEqual(["decisions", "systemone"]);
  });
});
