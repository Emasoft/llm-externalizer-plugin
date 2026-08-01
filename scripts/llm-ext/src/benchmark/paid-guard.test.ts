// Phase 2 (TRDD-8b6b3646): benchmarking a PAID model requires explicit opt-in —
// the --allow-paid-models-tests CLI flag or the allow_paid_models_tests MCP
// input. Free/$0 pools are never gated. Verifies the pure guard + the flag parse;
// the per-phase + MCP wiring is asserted at tsc/integration level.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setPaidBenchmarksAllowed,
  getPaidBenchmarksAllowed,
  assertPaidBenchmarkAllowed,
  withPaidBenchmarksAllowed,
} from "./discover.js";
import { setAllowPaidModels } from "../paid-switch.js";
import { parseArgs } from "./cli-args.js";

const paid = (id: string, input = 0.5, output = 0.5) => ({
  id,
  inputDollarsPerMillion: input,
  outputDollarsPerMillion: output,
});

describe("paid-benchmark opt-in — assertPaidBenchmarkAllowed", () => {
  // This describe exercises the INNER opt-in gate, which is only reachable once
  // the OUTER master switch is open — so open it here and reset the per-run opt-in
  // before every test. (The master switch itself is covered by its own describe
  // below.) Both flags are process-module state; reset so no test leaks into the next.
  beforeEach(() => {
    setAllowPaidModels(true);
    setPaidBenchmarksAllowed(false);
  });

  it("defaults to NOT allowed", () => {
    expect(getPaidBenchmarksAllowed()).toBe(false);
  });

  it("throws on a paid model when not opted in — names it and states $0 spent", () => {
    let msg = "";
    try {
      assertPaidBenchmarkAllowed([paid("deepseek/deepseek-v4-pro")]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("--allow-paid-models-tests");
    expect(msg).toContain("deepseek/deepseek-v4-pro");
    expect(msg).toContain("$0 spent");
  });

  it("does NOT throw once opted in", () => {
    setPaidBenchmarksAllowed(true);
    expect(() => assertPaidBenchmarkAllowed([paid("deepseek/deepseek-v4-pro")])).not.toThrow();
  });

  it("never gates a ':free' model, opt-in or not", () => {
    expect(() =>
      assertPaidBenchmarkAllowed([{ id: "x/y:free", inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }]),
    ).not.toThrow();
  });

  it("never gates a $0 catalog model even without the ':free' suffix (both prices zero)", () => {
    // A zero-cost model is not paid — nothing to spend, nothing to gate.
    expect(() => assertPaidBenchmarkAllowed([paid("some/zero-cost", 0, 0)])).not.toThrow();
  });

  it("gates the mix: a $0 model is fine but a paid sibling still trips the guard", () => {
    expect(() =>
      assertPaidBenchmarkAllowed([paid("free/one", 0, 0), paid("paid/two", 0.1, 0.1)]),
    ).toThrow(/paid\/two/);
  });
});

describe("paid-benchmark master switch — allow_paid_models is the OUTER gate (USER D4)", () => {
  // Restore the free-safe default after each test so this describe's `false`
  // never leaks into a later one that assumes paid is allowed.
  afterEach(() => setAllowPaidModels(true));

  it("BLOCKS a paid benchmark even WITH the opt-in, and cannot be overridden by it", () => {
    setAllowPaidModels(false); // paid globally off
    setPaidBenchmarksAllowed(true); // inner opt-in ON — must NOT be enough
    let msg = "";
    try {
      assertPaidBenchmarkAllowed([paid("deepseek/deepseek-v4-pro")]);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("allow_paid_models is false");
    expect(msg).toContain("cannot override the master switch");
    expect(msg).toContain("deepseek/deepseek-v4-pro");
    expect(msg).toContain("$0 spent");
  });

  it("still never gates a ':free' / $0 model — the switch only governs PAID spend", () => {
    setAllowPaidModels(false);
    setPaidBenchmarksAllowed(false);
    expect(() =>
      assertPaidBenchmarkAllowed([{ id: "x/y:free", inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 }]),
    ).not.toThrow();
    expect(() => assertPaidBenchmarkAllowed([paid("some/zero-cost", 0, 0)])).not.toThrow();
  });
});

describe("paid-benchmark opt-in — CLI flag parse", () => {
  it("defaults allowPaidModelsTests to false", () => {
    expect(parseArgs(["node", "bench"]).allowPaidModelsTests).toBe(false);
  });

  it("--allow-paid-models-tests sets it true", () => {
    expect(
      parseArgs(["node", "bench", "--allow-paid-models-tests"]).allowPaidModelsTests,
    ).toBe(true);
  });
});

describe("paid-benchmark opt-in — withPaidBenchmarksAllowed scoping", () => {
  // The flag is a process global; the MCP handlers serve ONE request each in a
  // long-lived server. A bare set() has no matching unset, so an opted-in call
  // would leave the process opted in for its entire remaining life and any later
  // in-process benchmark would inherit a paid permission its caller never granted.
  beforeEach(() => setPaidBenchmarksAllowed(false));

  it("restores the previous value after the call resolves", async () => {
    await withPaidBenchmarksAllowed(true, async () => {
      expect(getPaidBenchmarksAllowed()).toBe(true);
    });
    expect(getPaidBenchmarksAllowed()).toBe(false);
  });

  it("restores the previous value even when the body THROWS", async () => {
    await expect(
      withPaidBenchmarksAllowed(true, async () => {
        throw new Error("benchmark blew up");
      }),
    ).rejects.toThrow("benchmark blew up");
    expect(getPaidBenchmarksAllowed()).toBe(false);
  });

  it("restores a previously-TRUE value rather than forcing false", () => {
    setPaidBenchmarksAllowed(true);
    return withPaidBenchmarksAllowed(false, async () => {
      expect(getPaidBenchmarksAllowed()).toBe(false);
    }).then(() => {
      expect(getPaidBenchmarksAllowed()).toBe(true);
    });
  });
});
