/**
 * security-triage benchmark — WHICH model is actually sent, and free-mode safety.
 *
 * Hermetic end-to-end of the REAL orchestrator (`runSecurityTriageBenchmark`):
 * the only fakes are the two HTTP seams — the OpenRouter catalog (global fetch)
 * and the judge's FetchImpl. The dataset, the judge pipeline, the scorer, the
 * selection gate and the report writer are the production ones.
 *
 * Two claims are pinned here:
 *
 *  1. THE CANDIDATE IS THE MODEL SCORED. Every judge request carries the id of the
 *     model currently under assessment — the tool's DEFAULT model (`DEFAULT_MODEL`,
 *     a paid model) appears only as its OWN baseline run, never as the sender for a
 *     candidate's cases. Had the default leaked into the scoring path, every
 *     candidate would have been scored on the same model and every result would be
 *     meaningless — so this test is the regression fence for that class of bug.
 *
 *  2. FREE MODE NEVER SENDS A PAID MODEL. Under `free_only`, the paid incumbent is
 *     skipped (recorded, unbenchmarked, $0) instead of being sent — which is what
 *     used to abort the entire `--update-all --free` sweep at the incumbent's own
 *     baseline run. When NOTHING ':free' remains to assess, the benchmark reports a
 *     typed FreeModeSkipError (an honest skip), not the cost-safety guard's
 *     "this is a bug, please report it".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { setActiveFreeOnly } from "../../config.js";
import { setPaidBenchmarksAllowed } from "../discover.js";
import { DEFAULT_MODEL } from "../../security_scan/types.js";
import type { FetchImpl } from "../../security_scan/judge.js";
import type { OpenRouterModel } from "../discover.js";
import { FreeModeSkipError } from "../free-mode.js";
import { loadDataset } from "./dataset.js";
import { runSecurityTriageBenchmark } from "./index.js";

const CASES = loadDataset().length;

function orModel(id: string, inPerM: number, outPerM: number): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: 32_768,
    top_provider: { max_completion_tokens: 8_192 },
    // OpenRouter prices PER TOKEN; the orchestrator scales to $/M.
    pricing: { prompt: String(inPerM / 1_000_000), completion: String(outPerM / 1_000_000) },
    supported_parameters: ["structured_outputs"],
  } as OpenRouterModel;
}

const INCUMBENT = orModel(DEFAULT_MODEL, 0.04, 0.1); // the PAID security_scan default
const CHEAP_A = orModel("v/cheap-a", 0.01, 0.02);
const CHEAP_B = orModel("v/cheap-b", 0.02, 0.03);
const FREE_A = orModel("v/free-a:free", 0, 0);
const CATALOG: OpenRouterModel[] = [INCUMBENT, CHEAP_A, CHEAP_B, FREE_A];

const VERDICT = JSON.stringify({
  verdict: "uncertain",
  confidence: 0.5,
  reason: "benchmark stub",
  injection_observed: false,
});

/** Judge seam: records the model id on every request, replies with a valid verdict. */
function recordingJudge(sent: string[]): FetchImpl {
  return (async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(init.body ?? "{}") as { model?: string };
    sent.push(String(body.model));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: VERDICT } }],
        usage: { prompt_tokens: 40, completion_tokens: 15 },
      }),
      text: async () => VERDICT,
    };
  }) as unknown as FetchImpl;
}

function tally(ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = (out[id] ?? 0) + 1;
  return out;
}

describe("security-triage benchmark — model routing + free_only", () => {
  let cfg = "";
  let root = "";
  let prevKey: string | undefined;
  let prevCfgDir: string | undefined;

  beforeEach(() => {
    // "/tmp" (not os.tmpdir()) on purpose: getConfigDir refuses a config dir outside
    // $HOME or /private/tmp, and macOS's tmpdir() resolves to /var/folders/… .
    cfg = mkdtempSync(join("/tmp", "st-cfg-"));
    root = mkdtempSync(join("/tmp", "st-root-"));
    prevKey = process.env.OPENROUTER_API_KEY;
    prevCfgDir = process.env.LLM_EXT_CONFIG_DIR;
    process.env.OPENROUTER_API_KEY = "test-key";
    // Isolate the per-model-per-day result cache from the developer's real one.
    process.env.LLM_EXT_CONFIG_DIR = cfg;
    // These tests benchmark PAID candidates through a STUBBED fetch (no real
    // spend) to validate model ROUTING — so opt into paid benchmarking. Reset in
    // afterEach so the module-level flag never leaks into a sibling test.
    setPaidBenchmarksAllowed(true);
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: CATALOG }),
    }));
  });

  afterEach(() => {
    setActiveFreeOnly(false); // module state — never leak free_only into a sibling test
    setPaidBenchmarksAllowed(false);
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevCfgDir === undefined) delete process.env.LLM_EXT_CONFIG_DIR;
    else process.env.LLM_EXT_CONFIG_DIR = prevCfgDir;
    rmSync(cfg, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("scores each CANDIDATE on the candidate's own model — the tool default never stands in for it", async () => {
    const sent: string[] = [];
    const r = await runSecurityTriageBenchmark({
      models: ["v/cheap-a", "v/cheap-b"],
      force: true,
      mainRoot: root,
      outputDir: join(root, "reports"),
      fetchImpl: recordingJudge(sent),
    });

    const counts = tally(sent);
    // Each assessed model got its OWN full dataset run, under its OWN id.
    expect(counts["v/cheap-a"]).toBe(CASES);
    expect(counts["v/cheap-b"]).toBe(CASES);
    // The incumbent appears exactly ONCE as a run — its own baseline — and not as
    // the sender for anyone else's cases (that would be CASES × 3).
    expect(counts[DEFAULT_MODEL]).toBe(CASES);
    expect(sent).toHaveLength(CASES * 3);
    expect(new Set(sent)).toEqual(new Set(["v/cheap-a", "v/cheap-b", DEFAULT_MODEL]));
    // And every assessed model carries its own score row.
    expect(r.scores.map((s) => s.modelId).sort()).toEqual(
      ["v/cheap-a", "v/cheap-b", DEFAULT_MODEL].sort(),
    );
  });

  it("free_only: benchmarks the ':free' candidate and NEVER sends the paid incumbent", async () => {
    setActiveFreeOnly(true);
    const sent: string[] = [];
    const r = await runSecurityTriageBenchmark({
      models: ["v/free-a:free"],
      force: true,
      mainRoot: root,
      outputDir: join(root, "reports"),
      fetchImpl: recordingJudge(sent),
    });

    // The ':free' candidate WAS benchmarked…
    expect(tally(sent)["v/free-a:free"]).toBe(CASES);
    // …and the paid incumbent was never put on the wire (the abort's root cause).
    expect(sent).not.toContain(DEFAULT_MODEL);
    expect(new Set(sent)).toEqual(new Set(["v/free-a:free"]));

    // The incumbent is still ACCOUNTED FOR — as unbenchmarked, not as a pass.
    const inc = r.scores.find((s) => s.modelId === DEFAULT_MODEL);
    expect(inc).toBeDefined();
    expect(inc!.pass).toBe(false);
    expect(inc!.inconclusive).toBe(true);
    expect(inc!.scoredCount).toBe(0);
    expect(inc!.failReasons.join(" ")).toContain("free_only");
    // No paid model was sent, so the run cost nothing, and the incumbent is kept
    // (a ':free' model cannot be adopted as the default — allowFree=false).
    expect(r.costUsd).toBe(0);
    expect(r.recommendedModelId).toBe(DEFAULT_MODEL);
    expect(r.changed).toBe(false);

    const md = readFileSync(r.mdReportPath, "utf-8");
    expect(md).toContain("free_only active");
    expect(md).toContain(DEFAULT_MODEL);
  });

  it("free_only with NOTHING ':free' to assess: an honest typed skip, never 'please report it'", async () => {
    setActiveFreeOnly(true);
    const sent: string[] = [];
    await expect(
      runSecurityTriageBenchmark({
        models: ["v/cheap-a"], // paid — as is the incumbent the orchestrator adds
        force: true,
        mainRoot: root,
        outputDir: join(root, "reports"),
        fetchImpl: recordingJudge(sent),
      }),
    ).rejects.toBeInstanceOf(FreeModeSkipError);

    // Nothing was sent: the refusal happens BEFORE any judge call.
    expect(sent).toHaveLength(0);

    const err = await runSecurityTriageBenchmark({
      models: ["v/cheap-a"],
      force: true,
      mainRoot: root,
      outputDir: join(root, "reports"),
      fetchImpl: recordingJudge(sent),
    }).catch((e: unknown) => e as FreeModeSkipError);

    expect(err).toBeInstanceOf(FreeModeSkipError);
    expect(err.tool).toBe("security_scan");
    expect(err.nonFreeModelId).toBe(DEFAULT_MODEL);
    expect(err.message).toContain(`requires non-free model '${DEFAULT_MODEL}'`);
    // The cost-safety guard's hard-bug wording is reserved for a REAL leak.
    expect(err.message).not.toContain("please report it");
  });
});
