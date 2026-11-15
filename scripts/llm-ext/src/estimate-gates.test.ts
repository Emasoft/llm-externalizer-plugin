/**
 * --estimate applies the same send-time gates as a real run (TRDD-4TTFUIL0).
 *
 * The gate under test is the REAL sendRefusal / assertSendGates reading REAL
 * ledger files written into a temp LLM_EXT_CONFIG_DIR — no fetch mock, no stub
 * of the gate. Only the price lookup / manual set are plain data, as in the
 * provider layer's own deps.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { estimateToolRun, renderEstimate, type EstimateDeps } from "./estimate.js";
import {
  assertSendGates,
  FREE_ONLY_REFUSAL_PREFIX,
  sendRefusal,
} from "./provider/connection.js";
import { assertFreeOnlyModel } from "./config.js";
import { ctxStore, withUsageContext } from "./usage-history.js";
import { clearValidatedMemo, recordGeneralKeywordPasses } from "./benchmark/validated.js";
import type { BackendConfig, ProviderDeps } from "./provider/types.js";

const CEILING = 1.3;
type Price = { inputDollarsPerMillion: number; outputDollarsPerMillion: number } | null;
let cfgDir: string;
let savedCfg: string | undefined;

beforeEach(() => {
  savedCfg = process.env.LLM_EXT_CONFIG_DIR;
  // /tmp (not os.tmpdir()): getConfigDir only accepts $HOME or /private/tmp.
  cfgDir = mkdtempSync(join("/tmp", "llmext-estgates-"));
  process.env.LLM_EXT_CONFIG_DIR = cfgDir;
  clearValidatedMemo();
});

afterEach(() => {
  if (savedCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = savedCfg;
  clearValidatedMemo();
  rmSync(cfgDir, { recursive: true, force: true });
});

function gateProviderDeps(opts: {
  billable?: boolean;
  freeOnly?: boolean;
  manual?: boolean;
  price?: Price | ((model: string) => Price);
}): Pick<
  ProviderDeps,
  | "isFreeOnly"
  | "isManualModel"
  | "getModelPricePerMillion"
  | "getEnsemblePriceCeilingUsd"
  | "getBackend"
  | "routeForModel"
> {
  return {
    isFreeOnly: () => opts.freeOnly === true,
    isManualModel: () => opts.manual === true,
    getModelPricePerMillion: (m: string) => {
      const p = opts.price;
      if (typeof p === "function") return p(m);
      return p === undefined ? { inputDollarsPerMillion: 0.5, outputDollarsPerMillion: 1 } : p;
    },
    getEnsemblePriceCeilingUsd: () => CEILING,
    getBackend: () => ({ billable: opts.billable !== false }) as BackendConfig,
    routeForModel: () => null,
  };
}

function gatedDeps(opts: {
  model?: string;
  models?: string[];
  billable?: boolean;
  freeOnly?: boolean;
  manual?: boolean;
  price?: Price | ((model: string) => Price);
}): EstimateDeps {
  const gateDeps = gateProviderDeps(opts);
  const models = opts.models ?? [opts.model as string];
  return {
    resolveFiles: () => ({ files: [] }),
    fileSizeBytes: () => 4000,
    ensembleSlots: () => models.map((id) => ({ id, maxOutput: 8000 })),
    pricingFor: () => ({ inputUsdPerM: 0.5, outputUsdPerM: 1 }),
    defaultMaxTokens: () => 4000,
    slotRefusal: (tool, model) => sendRefusal(model, tool, gateDeps),
  };
}

const ARGS = { input_content: "hello world" };

describe("estimateToolRun — send-time gates", () => {
  it("refuses an auto-picked paid model that has no benchmark pass, before any cost line", () => {
    expect(() => estimateToolRun("summarize", ARGS, gatedDeps({ model: "vendor/unvalidated" }))).toThrow(
      /^WOULD BE REFUSED: vendor\/unvalidated: IRON RULE: model 'vendor\/unvalidated' is not validated for summarize.*llm-ext-benchmark/s,
    );
  });

  it("prints the normal estimate for a model with a real ledger pass", () => {
    recordGeneralKeywordPasses([{ modelId: "vendor/validated", ok: true, pass: true, schemaCompliant: true }]);
    const e = estimateToolRun("summarize", ARGS, gatedDeps({ model: "vendor/validated" }));
    expect(e.rows[0].model).toBe("vendor/validated");
    expect(e.totalCeilingUsd).not.toBeNull();
    expect(e.dropped).toEqual([]);
  });

  it("prints the normal estimate for a hand-listed (manual) model with no ledger and no price", () => {
    const e = estimateToolRun(
      "summarize",
      ARGS,
      gatedDeps({ model: "vendor/mine", manual: true, price: null }),
    );
    expect(e.rows[0].model).toBe("vendor/mine");
  });

  it("prints the normal estimate for a non-billable (local) model", () => {
    const e = estimateToolRun("summarize", ARGS, gatedDeps({ model: "local/model", billable: false, price: null }));
    expect(e.rows[0].model).toBe("local/model");
  });

  it("prints the normal estimate for a ':free' model with no ledger pass", () => {
    const e = estimateToolRun(
      "summarize",
      ARGS,
      gatedDeps({ model: "vendor/m:free", price: { inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 } }),
    );
    expect(e.totalCeilingUsd).toBe(0);
  });

  it("refuses a validated model priced over the ceiling", () => {
    recordGeneralKeywordPasses([{ modelId: "vendor/pricey", ok: true, pass: true, schemaCompliant: true }]);
    expect(() =>
      estimateToolRun(
        "summarize",
        ARGS,
        gatedDeps({ model: "vendor/pricey", price: { inputDollarsPerMillion: 5, outputDollarsPerMillion: 5 } }),
      ),
    ).toThrow(/^WOULD BE REFUSED: vendor\/pricey: refusing to send auto-picked paid model 'vendor\/pricey'.*exceeds the \$1.3\/M ceiling/s);
  });

  it("refuses a validated model with no recorded price (cold cache fails closed)", () => {
    recordGeneralKeywordPasses([{ modelId: "vendor/unpriced", ok: true, pass: true, schemaCompliant: true }]);
    expect(() =>
      estimateToolRun("summarize", ARGS, gatedDeps({ model: "vendor/unpriced", price: null })),
    ).toThrow(/^WOULD BE REFUSED: .*no recorded price data/s);
  });

  it("keeps going when only SOME slots are refused: they are shown as dropped, not billed", () => {
    recordGeneralKeywordPasses([{ modelId: "vendor/ok", ok: true, pass: true, schemaCompliant: true }]);
    const e = estimateToolRun("summarize", ARGS, gatedDeps({ models: ["vendor/bad", "vendor/ok"] }));
    expect(e.rows.map((r) => r.model)).toEqual(["vendor/ok"]);
    expect(e.requests).toBe(1);
    expect(e.dropped.map((d) => d.model)).toEqual(["vendor/bad"]);
    expect(renderEstimate(e)).toMatch(/DROPPED .*vendor\/bad — IRON RULE/);
  });

  it("refuses when EVERY slot is refused, naming each", () => {
    expect(() =>
      estimateToolRun("summarize", ARGS, gatedDeps({ models: ["vendor/a", "vendor/b"] })),
    ).toThrow(/^WOULD BE REFUSED: vendor\/a: .* \| vendor\/b: /s);
  });

  it("refuses a paid model under free_only, as the real send does", () => {
    expect(() =>
      estimateToolRun("summarize", ARGS, gatedDeps({ model: "vendor/paid", freeOnly: true, manual: true })),
    ).toThrow(/^WOULD BE REFUSED: vendor\/paid: free_only cost-safety: refusing to send non-free model/);
  });

  it("the free_only prefix constant matches assertFreeOnlyModel's real message", () => {
    expect(() => assertFreeOnlyModel(true, true, "vendor/paid")).toThrow(
      new RegExp(`^${FREE_ONLY_REFUSAL_PREFIX}`),
    );
  });

  it("does not relabel a non-refusal failure as WOULD BE REFUSED: it propagates unchanged", () => {
    const boom = new TypeError("corrupt ledger");
    const deps: EstimateDeps = {
      ...gatedDeps({ model: "vendor/x" }),
      slotRefusal: () => {
        throw boom;
      },
    };
    expect(() => estimateToolRun("summarize", ARGS, deps)).toThrow(boom);
    // and through the real sendRefusal: a throwing dep is not a refusal
    const broken = {
      ...gateProviderDeps({}),
      getModelPricePerMillion: () => {
        throw boom;
      },
    };
    expect(() => sendRefusal("vendor/x", undefined, broken)).toThrow(boom);
  });

  it("estimate passes the same tool name a real send holds in ctxStore, and gets the same refusal", () => {
    const deps = gateProviderDeps({});
    const seen: string[] = [];
    const estimateDeps: EstimateDeps = {
      ...gatedDeps({ model: "vendor/unvalidated" }),
      slotRefusal: (tool, model) => {
        seen.push(tool);
        return sendRefusal(model, tool, deps);
      },
    };
    let sendMsg = "";
    withUsageContext({ tool: "summarize", params: "" }, () => {
      try {
        assertSendGates("vendor/unvalidated", null, { billable: true }, ctxStore.getStore()?.tool, deps);
      } catch (err) {
        sendMsg = (err as Error).message;
      }
    });
    expect(sendMsg).toMatch(/^IRON RULE/);
    expect(() => estimateToolRun("summarize", ARGS, estimateDeps)).toThrow(sendMsg);
    expect(seen).toEqual(["summarize"]);
  });
});