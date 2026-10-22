// --bench-free-pool must benchmark ONLY the free pool: the roster may not gain PAID
// auto-discovered candidates (they made assertPaidBenchmarkAllowed abort the run).
// Drives the REAL runKeywordSweep (--dry-run, so no model call) against a fixture
// OpenRouter catalog served through the global fetch seam.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "../test-tmp-root.js";
import { parseArgs } from "./cli-args.js";
import { runKeywordSweep } from "./index.js";

const model = (id: string, price: string) => ({
  id,
  name: id,
  context_length: 200_000,
  pricing: { prompt: price, completion: price },
  top_provider: { max_completion_tokens: 100_000 },
  supported_parameters: ["structured_outputs", "response_format", "reasoning"],
});

const CATALOG = [model("vendor/paid-cheap", "0.0000001"), model("vendor/free-one:free", "0")];

// Hermetic settings: loadSettings() must not read the operator's real ~/.llm-externalizer.
const savedCfg = process.env.LLM_EXT_CONFIG_DIR;
beforeEach(() => {
  process.env.LLM_EXT_CONFIG_DIR = mkdtempSync(join(tmpdir(), "bench-free-pool-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(process.env.LLM_EXT_CONFIG_DIR as string, { recursive: true, force: true });
  if (savedCfg === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
  else process.env.LLM_EXT_CONFIG_DIR = savedCfg;
});

describe("runKeywordSweep roster under --bench-free-pool", () => {
  it("keeps paid auto-discovered candidates out; the free pool rides in as baselines", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: CATALOG })));
    const opts = parseArgs(["node", "bench", "--bench-free-pool", "--dry-run"]);
    // main() parks the resolved pool in includeIds before the sweep; do the same.
    opts.includeIds.push("vendor/free-one:free");
    const out = await runKeywordSweep(opts, true);
    expect(out.candidates).toBe(0);
    expect(out.baselines).toBe(1);
  });
});
