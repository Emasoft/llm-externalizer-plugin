// Unit tests for the auto-replacement loop CORE (TRDD-828238b5 A7-P2).
//
// planToolReplacements is driven with INJECTED seams (a fake settingsReader and
// a fake benchmarkRunner) plus a REAL temp ledger file written via the real
// appendModelEvent — so the planner's actual aggregate-then-decide logic runs
// end-to-end without any network or module mocking.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  planToolReplacements,
  type ReplacementBenchmarkOutcome,
  type ToolSettingsReader,
} from "./auto-replace.js";
import { appendModelEvent, getModelEventsPath } from "../model-events.js";

const ORIG_CFG = process.env.LLM_EXT_CONFIG_DIR;
let tmp: string;

beforeEach(() => {
  // getConfigDir() only permits paths under $HOME or /tmp (→ /private/tmp on
  // macOS). os.tmpdir() resolves to /var/folders/... which the guard rejects,
  // so use /tmp directly — matching model-events.test.ts.
  tmp = mkdtempSync(join("/tmp", "auto-replace-"));
  process.env.LLM_EXT_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (ORIG_CFG !== undefined) process.env.LLM_EXT_CONFIG_DIR = ORIG_CFG;
  else delete process.env.LLM_EXT_CONFIG_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake reader pinning each tool's incumbent to a chosen model id. */
function fakeReader(incumbent: string, profileName = "test-profile"): () => ToolSettingsReader {
  return () => ({ profileName, toolModel: () => incumbent });
}

/** Records every benchmark invocation so a test can assert it ran (or didn't). */
function recordingRunner(outcome: ReplacementBenchmarkOutcome) {
  const calls: { tool: string; benchmark: string; incumbent: string }[] = [];
  const runner = async (
    tool: string,
    benchmark: string,
    incumbentModelId: string,
  ): Promise<ReplacementBenchmarkOutcome> => {
    calls.push({ tool, benchmark, incumbent: incumbentModelId });
    return outcome;
  };
  return { runner, calls };
}

describe("planToolReplacements — healthy ledger", () => {
  it("runs NO benchmark and every finding is changed=false on an empty ledger", async () => {
    const { runner, calls } = recordingRunner({
      recommendedModelId: "should/not/be/used",
      changed: true,
      reason: "irrelevant — must not run",
    });
    const { findings, reportMarkdown } = await planToolReplacements({
      eventsPath: getModelEventsPath(), // file does not exist → [] events
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });

    expect(calls).toHaveLength(0);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(f.ranBenchmark).toBe(false);
      expect(f.changed).toBe(false);
      expect(f.degraded).toBe(false);
      expect(f.recommendedModelId).toBe("incumbent/model");
      expect(f.reason).toBe("model healthy — no benchmark run");
    }
    expect(reportMarkdown).toContain("Auto-replacement plan");
  });

  it("a few non-retryable failures BELOW the threshold do not trigger a benchmark", async () => {
    // Default nonRetryableFailureThreshold is 3 → 2 failures stays healthy.
    appendModelEvent("incumbent/model", "non_retryable_failure", "429-adjacent");
    appendModelEvent("incumbent/model", "non_retryable_failure", "transient");
    const { runner, calls } = recordingRunner({
      recommendedModelId: "x",
      changed: true,
      reason: "must not run",
    });
    const { findings } = await planToolReplacements({
      eventsPath: getModelEventsPath(),
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });
    expect(calls).toHaveLength(0);
    for (const f of findings) expect(f.ranBenchmark).toBe(false);
  });
});

describe("planToolReplacements — degraded incumbent", () => {
  it("runs the benchmark and recommends the cheaper passer (changed=true) when degraded", async () => {
    // Cross the default non-retryable threshold (>= 3) for the incumbent.
    for (let i = 0; i < 4; i += 1) {
      appendModelEvent("incumbent/model", "non_retryable_failure", `fail ${i}`);
    }
    const { runner, calls } = recordingRunner({
      recommendedModelId: "cheaper/passer",
      changed: true,
      reason: "RECOMMEND switch: incumbent/model -> cheaper/passer (best same-or-cheaper passer).",
      rejected: [{ modelId: "pricey/model", reason: "pricier than incumbent" }],
    });
    const { findings, reportMarkdown } = await planToolReplacements({
      eventsPath: getModelEventsPath(),
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });

    // Every benchmarked tool whose incumbent == incumbent/model is degraded, so
    // every one runs the benchmark.
    expect(calls.length).toBe(findings.length);
    for (const f of findings) {
      expect(f.degraded).toBe(true);
      expect(f.ranBenchmark).toBe(true);
      expect(f.changed).toBe(true);
      expect(f.recommendedModelId).toBe("cheaper/passer");
      expect(f.rejected).toEqual([{ modelId: "pricey/model", reason: "pricier than incumbent" }]);
      expect(f.health.reasons.join(" ")).toContain("non-retryable");
    }
    expect(reportMarkdown).toContain("recommended replacement");
    expect(reportMarkdown).toContain("cheaper/passer");
    expect(reportMarkdown).toContain("DEGRADED");
  });

  it("degraded but no eligible cheaper passer keeps the incumbent (changed=false)", async () => {
    for (let i = 0; i < 3; i += 1) {
      appendModelEvent("incumbent/model", "empty_response", `empty ${i}`);
    }
    const { runner } = recordingRunner({
      recommendedModelId: "incumbent/model",
      changed: false,
      reason: "no eligible same-or-cheaper model scored higher; keeping incumbent.",
    });
    const { findings } = await planToolReplacements({
      eventsPath: getModelEventsPath(),
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });
    for (const f of findings) {
      expect(f.degraded).toBe(true);
      expect(f.ranBenchmark).toBe(true);
      expect(f.changed).toBe(false);
      expect(f.recommendedModelId).toBe("incumbent/model");
    }
  });
});

describe("planToolReplacements — force", () => {
  it("force=true runs the benchmark even on a healthy model", async () => {
    // No events → healthy. force should still run every benchmark.
    const { runner, calls } = recordingRunner({
      recommendedModelId: "incumbent/model",
      changed: false,
      reason: "audit: incumbent still best.",
    });
    const { findings } = await planToolReplacements({
      eventsPath: getModelEventsPath(),
      force: true,
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });
    expect(calls.length).toBe(findings.length);
    for (const f of findings) {
      expect(f.degraded).toBe(false); // healthy ledger
      expect(f.ranBenchmark).toBe(true); // but forced
    }
  });
});

describe("planToolReplacements — report shape", () => {
  it("the report markdown contains a section for each benchmarked tool", async () => {
    const { runner } = recordingRunner({
      recommendedModelId: "incumbent/model",
      changed: false,
      reason: "healthy audit",
    });
    const { findings, reportMarkdown } = await planToolReplacements({
      eventsPath: getModelEventsPath(),
      force: true,
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });
    // Every tool the registry declares a DISPATCHABLE benchmark for must appear.
    // code_task joined in P2b (its code-audit corpus) and scan_folder in P2c (its
    // mass-search corpus), so the planner now covers four tools — if a fifth
    // benchmark ships, this list grows with it.
    expect(findings.map((f) => f.tool).sort()).toEqual(
      ["code_task", "scan_folder", "search_existing_implementations", "security_scan"].sort(),
    );
    for (const f of findings) {
      expect(reportMarkdown).toContain(`## ${f.tool} (benchmark: ${f.benchmark})`);
    }
    expect(reportMarkdown).toContain("test-profile");
    expect(reportMarkdown).toContain("ADVISORY ONLY");
  });

  it("each tool is benchmarked with the registry-declared benchmark id", async () => {
    for (let i = 0; i < 4; i += 1) appendModelEvent("incumbent/model", "non_retryable_failure", "x");
    const { runner, calls } = recordingRunner({
      recommendedModelId: "incumbent/model",
      changed: false,
      reason: "kept",
    });
    await planToolReplacements({
      eventsPath: getModelEventsPath(),
      settingsReader: fakeReader("incumbent/model"),
      benchmarkRunner: runner,
    });
    const byTool = Object.fromEntries(calls.map((c) => [c.tool, c.benchmark]));
    expect(byTool["security_scan"]).toBe("security-triage");
    expect(byTool["search_existing_implementations"]).toBe("search-existing");
    expect(byTool["code_task"]).toBe("code-task");
    expect(byTool["scan_folder"]).toBe("scan-folder");
  });
});
