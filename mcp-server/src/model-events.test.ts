// Tests for the durable model-health event ledger (TRDD-828238b5 A1).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendModelEvent,
  parseModelEventLine,
  readModelEvents,
  aggregateModelHealth,
  getModelEventsPath,
  MODEL_EVENT_KINDS,
  type ModelEvent,
} from "./model-events.js";

const ORIG_CFG = process.env.LLM_EXT_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  // mkdtemp under /tmp specifically: getConfigDir() only permits paths under
  // $HOME or /tmp (→ /private/tmp on macOS). os.tmpdir() resolves to
  // /var/folders/... on macOS, which the guard rejects — so use /tmp directly.
  tmp = mkdtempSync(join("/tmp", "model-events-"));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (ORIG_CFG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG_CFG;
  else delete process.env.LLM_EXT_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("appendModelEvent + readModelEvents round-trip", () => {
  it("writes to model-events.log under the config dir and reads back parsed", () => {
    appendModelEvent("google/gemini-2.5-flash", "param_drop", "dropped temperature");
    appendModelEvent("google/gemini-2.5-flash", "rate_limit_429", "halved RPS");
    // getConfigDir() realpath-resolves (/tmp → /private/tmp on macOS), so only
    // assert the filename + that the file exists with the expected line count.
    const path = getModelEventsPath();
    expect(path.endsWith("model-events.log")).toBe(true);
    expect(readFileSync(path, "utf-8").split("\n").filter(Boolean).length).toBe(2);

    const events = readModelEvents();
    expect(events).toHaveLength(2);
    expect(events[0].model).toBe("google/gemini-2.5-flash");
    expect(events[0].kind).toBe("param_drop");
    expect(events[0].detail).toBe("dropped temperature");
    expect(events[1].kind).toBe("rate_limit_429");
  });

  it("missing log file reads as an empty array (best-effort)", () => {
    expect(readModelEvents()).toEqual([]);
  });

  it("limit keeps only the most-recent N events (the tail)", () => {
    for (let i = 0; i < 5; i++) appendModelEvent("m", "schema_heal", `heal ${i}`);
    const last2 = readModelEvents({ limit: 2 });
    expect(last2).toHaveLength(2);
    expect(last2[0].detail).toBe("heal 3");
    expect(last2[1].detail).toBe("heal 4");
  });
});

describe("line format safety", () => {
  it("sanitizes a model id containing the field separator so the line shape survives", () => {
    appendModelEvent("weird - model", "param_drop", "x");
    const events = readModelEvents();
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe("weird | model");
    expect(events[0].kind).toBe("param_drop");
  });

  it("detail containing ' - ' round-trips (split keeps the remainder intact)", () => {
    appendModelEvent("m", "non_retryable_failure", "HTTP 400 - bad request - foo");
    const events = readModelEvents();
    expect(events[0].detail).toBe("HTTP 400 - bad request - foo");
  });

  it("truncates an over-long detail", () => {
    appendModelEvent("m", "schema_heal", "x".repeat(500));
    const ev = readModelEvents()[0];
    expect(ev.detail.length).toBeLessThanOrEqual(160);
    expect(ev.detail.endsWith("…")).toBe(true);
  });
});

describe("parseModelEventLine", () => {
  it("returns null for blank or too-short lines", () => {
    expect(parseModelEventLine("")).toBeNull();
    expect(parseModelEventLine("   ")).toBeNull();
    expect(parseModelEventLine("a - b")).toBeNull();
  });

  it("returns null for an unknown kind", () => {
    expect(parseModelEventLine("2026-01-01T00:00:00+0000 - m - not_a_kind - x")).toBeNull();
  });

  it("parses a well-formed line with empty detail", () => {
    const ev = parseModelEventLine("2026-01-01T00:00:00+0000 - m - empty_response - ");
    expect(ev).not.toBeNull();
    expect(ev?.kind).toBe("empty_response");
    expect(ev?.detail).toBe("");
  });
});

describe("aggregateModelHealth (pure)", () => {
  function ev(model: string, kind: ModelEvent["kind"]): ModelEvent {
    return { timestamp: "2026-01-01T00:00:00+0000", model, kind, detail: "" };
  }

  it("counts events per model and per kind", () => {
    const summary = aggregateModelHealth([
      ev("a", "param_drop"),
      ev("a", "param_drop"),
      ev("a", "rate_limit_429"),
      ev("b", "schema_heal"),
    ]);
    expect(summary.get("a")?.total).toBe(3);
    expect(summary.get("a")?.byKind.param_drop).toBe(2);
    expect(summary.get("a")?.byKind.rate_limit_429).toBe(1);
    expect(summary.get("b")?.byKind.schema_heal).toBe(1);
  });

  it("flags degraded on the non-retryable-failure threshold", () => {
    const events = [ev("a", "non_retryable_failure"), ev("a", "non_retryable_failure"), ev("a", "non_retryable_failure")];
    const a = aggregateModelHealth(events).get("a")!;
    expect(a.degraded).toBe(true);
    expect(a.reasons.join(" ")).toContain("non-retryable");
  });

  it("flags degraded on the empty-response threshold", () => {
    const events = [ev("a", "empty_response"), ev("a", "empty_response"), ev("a", "empty_response")];
    expect(aggregateModelHealth(events).get("a")!.degraded).toBe(true);
  });

  it("flags degraded on the schema-heal threshold (structured-output instability)", () => {
    const events = Array.from({ length: 5 }, () => ev("a", "schema_heal"));
    const a = aggregateModelHealth(events).get("a")!;
    expect(a.degraded).toBe(true);
    expect(a.reasons.join(" ")).toContain("structured-output");
  });

  it("a model below all thresholds is healthy", () => {
    const a = aggregateModelHealth([
      ev("a", "param_drop"),
      ev("a", "rate_limit_429"),
      ev("a", "non_retryable_failure"),
    ]).get("a")!;
    expect(a.degraded).toBe(false);
    expect(a.reasons).toEqual([]);
  });

  it("respects custom thresholds", () => {
    const events = [ev("a", "non_retryable_failure")];
    expect(aggregateModelHealth(events, { nonRetryableFailureThreshold: 1 }).get("a")!.degraded).toBe(true);
  });

  it("zero-initialises every kind in byKind", () => {
    const a = aggregateModelHealth([ev("a", "param_drop")]).get("a")!;
    for (const k of MODEL_EVENT_KINDS) expect(typeof a.byKind[k]).toBe("number");
  });
});
