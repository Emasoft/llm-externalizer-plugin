// DW-01: the drift event kinds round-trip through the ledger and never count as model ill-health.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  appendModelEvent,
  readModelEvents,
  aggregateModelHealth,
  MODEL_EVENT_KINDS,
  DRIFT_EVENT_KINDS,
  parseModelEventLine,
  type ModelEvent,
} from "./model-events.js";

const ORIG_CFG = process.env.LLM_EXT_CONFIG_DIR;
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join("/tmp", "llm-ext-dw01-"));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});
afterEach(() => {
  if (ORIG_CFG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG_CFG;
  else delete process.env.LLM_EXT_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("drift event kinds", () => {
  it("are the four catalog changes the drift watcher reports", () => {
    expect([...DRIFT_EVENT_KINDS]).toEqual(["canonical_slug_change", "alias_target_change", "price_change", "presence_change"]);
    for (const k of DRIFT_EVENT_KINDS) expect(MODEL_EVENT_KINDS).toContain(k);
  });
  it("round-trip through the ledger and the line parser", () => {
    for (const k of DRIFT_EVENT_KINDS) appendModelEvent("~typesafe/jev-latest", k, "a -> b");
    const events = readModelEvents();
    expect(events.map((e) => e.kind)).toEqual([...DRIFT_EVENT_KINDS]);
    expect(parseModelEventLine("2026-10-10T00:00:00+0200 - m - price_change - x")?.kind).toBe("price_change");
  });
  it("aggregateModelHealth keeps a zero count for every kind and ignores drift events for total and degraded", () => {
    const drift: ModelEvent[] = DRIFT_EVENT_KINDS.flatMap((kind) => Array.from({ length: 6 }, () => ({ timestamp: "t", model: "m", kind, detail: "" })));
    const s = aggregateModelHealth([...drift, { timestamp: "t", model: "m", kind: "param_drop", detail: "" }]).get("m")!;
    expect(s.total).toBe(1);
    expect(s.degraded).toBe(false);
    expect(Object.keys(s.byKind).sort()).toEqual([...MODEL_EVENT_KINDS].sort());
    expect(s.byKind.price_change).toBe(0);
  });
});
