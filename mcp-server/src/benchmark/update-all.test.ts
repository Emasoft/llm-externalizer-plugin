// `--update-all` — the whole model refresh as ONE command (P3), under the hard spend
// cap (P4).
//
// The THING UNDER TEST is the ORCHESTRATOR: the requirement gate, the pre-flight cost
// estimate, the abort rules, the writers, and the benchmark-proven vs requirement-gated
// distinction in the report. All of that is the REAL code.
//
// Seams (not mocks of the subject): the OpenRouter CATALOG (network) and the per-tool
// BENCHMARK RUNNERS (each of which has its own dedicated test suite). settings.yaml is
// a REAL file in a tmp dir, written by the REAL atomic writers — so a broken write is a
// failing test here, not a surprise in production.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

import {
  runUpdateAll,
  estimateWorkloadCostUsd,
  type UpdateAllDeps,
  type UpdateAllOptions,
  type ToolBenchmarkRun,
  type EnsembleSweepRun,
} from "./update-all.js";
import { registeredTools } from "../model-qualification/registry.js";
import type { OpenRouterModel } from "./discover.js";
import type { BenchmarkWorkload } from "./workload-types.js";
import type { FetchImpl } from "../security_scan/judge.js";
import { setActiveFreeOnly } from "../config.js";

// ── Catalog fixtures ────────────────────────────────────────────────────────

/** A model that clears DEFAULT_CRITERIA (128K ctx / 64K out / structured + reasoning). */
function model(id: string, inPerM: number, outPerM: number): OpenRouterModel {
  return {
    id,
    name: id,
    context_length: 256_000,
    top_provider: { max_completion_tokens: 128_000 },
    pricing: { prompt: String(inPerM / 1_000_000), completion: String(outPerM / 1_000_000) },
    supported_parameters: ["structured_outputs", "reasoning"],
  } as unknown as OpenRouterModel;
}

const CHEAP = model("v/cheap", 0.1, 0.2);
const MID = model("v/mid", 0.3, 0.4);
const FREE_A = model("v/alpha:free", 0, 0);
const FREE_B = model("v/beta:free", 0, 0);
const CATALOG: OpenRouterModel[] = [CHEAP, MID, FREE_A, FREE_B];

const SETTINGS = [
  "active: ens",
  "profiles:",
  "  ens:",
  "    mode: remote-ensemble",
  "    api: openrouter-remote",
  "    model: v/incumbent",
  "    second_model: v/incumbent2",
  "    api_key: sk-test-literal",
  "",
].join("\n");

/** The ensemble sweep's workload — a small, realistic stand-in for the fixture prompt. */
const ENSEMBLE_WORKLOAD: BenchmarkWorkload = {
  tool: "ensemble",
  benchmark: "keyword-classification",
  callsPerModel: 1,
  promptCharsPerModel: 30_000,
  maxOutputTokensPerCall: 16_000,
};

describe("--update-all", () => {
  let cfg = "";
  let root = "";
  let settingsPath = "";

  beforeEach(() => {
    cfg = mkdtempSync(join("/tmp", "ua-cfg-"));
    root = mkdtempSync(join("/tmp", "ua-root-"));
    settingsPath = join(cfg, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS);
  });
  afterEach(() => {
    setActiveFreeOnly(false); // module state — never leak free_only into a sibling test
    rmSync(cfg, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  function baseOpts(over: Partial<UpdateAllOptions> = {}): UpdateAllOptions {
    return {
      mode: "paid",
      budgetUsd: 100,
      dryRun: false,
      settingsPath,
      profileName: "ens",
      configuredFreeModels: [],
      qualifyingTopN: 15,
      ensembleTopN: 2,
      force: false,
      mainRoot: root,
      ...over,
    };
  }

  /** Records every call the orchestrator makes into the seams. */
  function spyDeps(
    over: Partial<UpdateAllDeps> = {},
  ): { deps: UpdateAllDeps; toolCalls: string[]; sweepCalls: number } {
    const toolCalls: string[] = [];
    const box = { sweepCalls: 0 };
    const deps: UpdateAllDeps = {
      fetchCatalog: async () => CATALOG,
      describeEnsembleWorkload: () => ENSEMBLE_WORKLOAD,
      runEnsembleSweep: async ({ models, topN }) => {
        box.sweepCalls++;
        const run: EnsembleSweepRun = {
          picks: models.slice(0, topN).map((id) => ({
            modelId: id,
            meanF1: 1,
            actualCost: 0,
            latencyMs: 1,
            inputDollarsPerMillion: 0,
            outputDollarsPerMillion: 0,
          })),
          pickError: null,
          passingFreeIds: models.filter((m) => m.endsWith(":free")),
          modelsRun: models.length,
          passers: models.length,
          costUsd: 0,
          reportPath: join(root, "sweep.md"),
        };
        return run;
      },
      runToolBenchmark: async ({ tool, models }) => {
        toolCalls.push(tool);
        const run: ToolBenchmarkRun = {
          recommendedModelId: models[0] ?? "v/incumbent",
          changed: true,
          eligibleCount: models.length,
          costUsd: 0,
          reportPath: join(root, `${tool}.md`),
        };
        return run;
      },
      ...over,
    };
    return {
      deps,
      toolCalls,
      get sweepCalls(): number {
        return box.sweepCalls;
      },
    } as { deps: UpdateAllDeps; toolCalls: string[]; sweepCalls: number };
  }

  // ── The report's central honesty claim ───────────────────────────────────

  it("accounts for EVERY registered tool — none may silently vanish from the report", async () => {
    // The bug this pins: `mass_scout` is gated by the keyword-classification benchmark
    // (the ENSEMBLE sweep), so it has no per-tool sweep — and it fell straight through
    // the plan loop into no row at all. The summary read "5 + 5" against an 11-tool
    // registry and nothing said a tool was missing. A silently-omitted tool is exactly
    // the failure this module exists to prevent, so the count is now asserted.
    const { deps } = spyDeps();
    const r = await runUpdateAll(baseOpts(), deps);

    const reported = r.tools.map((t) => t.tool).sort();
    expect(reported).toEqual(registeredTools().sort());
    expect(r.tools).toHaveLength(registeredTools().length);

    // mass_scout specifically: PROVEN (the keyword sweep is its golden dataset), but
    // served by the ensemble — so no per-tool write.
    const ms = r.tools.find((t) => t.tool === "mass_scout");
    expect(ms?.gate).toBe("benchmark-proven");
    expect(ms?.benchmark).toBe("keyword-classification");
    expect(ms?.written).toBe(false);
    expect(ms?.note).toMatch(/served by the ensemble default/);
  });

  it("labels every tool benchmark-proven or requirement-gated — and NEVER blurs the two", async () => {
    const { deps } = spyDeps();
    const r = await runUpdateAll(baseOpts(), deps);

    const proven = r.tools.filter((t) => t.gate === "benchmark-proven").map((t) => t.tool).sort();
    const gated = r.tools.filter((t) => t.gate === "requirement-gated").map((t) => t.tool).sort();

    // Every tool that owns a golden dataset. mass_scout's dataset IS the keyword sweep
    // (the ensemble), so it is proven too — it just has no per-tool sweep of its own.
    expect(proven).toEqual(
      [
        "check_against_specs",
        "code_task",
        "mass_scout",
        "scan_folder",
        "search_existing_implementations",
        "security_scan",
      ].sort(),
    );
    // Everything else carries `benchmark: null` in the registry — requirements only.
    expect(gated).toEqual(
      ["chat", "check_imports", "check_references", "cluster_synonyms", "compare_files"].sort(),
    );

    // A requirement-gated tool must never claim a benchmark, a winner, or a write.
    for (const t of r.tools.filter((x) => x.gate === "requirement-gated")) {
      expect(t.benchmark).toBeNull();
      expect(t.benchmarkedModels).toBe(0);
      expect(t.winner).toBeNull();
      expect(t.written).toBe(false);
      expect(t.note).toMatch(/NOT benchmark-proven/);
    }

    // …and the written report says so in words, not just in a column.
    const md = readFileSync(r.reportPath, "utf-8");
    expect(md).toContain("no benchmark exists for that");
    expect(md).toContain("requirement-gated");
    expect(md).toContain("**benchmark-proven**");
  });

  // ── The writers ──────────────────────────────────────────────────────────

  it("writes the ensemble AND each tool winner into settings.yaml (atomic, other keys intact)", async () => {
    const { deps, toolCalls } = spyDeps();
    const r = await runUpdateAll(baseOpts(), deps);

    expect(r.ok).toBe(true);
    expect(toolCalls.sort()).toEqual(
      ["check_against_specs", "code_task", "scan_folder", "search_existing_implementations", "security_scan"].sort(),
    );

    const doc = yamlParse(readFileSync(settingsPath, "utf-8"));
    // Ensemble re-picked (2 slots — the profile's CURRENT count, not a hard-coded 3).
    expect(doc.profiles.ens.model).toBe("v/cheap");
    expect(doc.profiles.ens.second_model).toBe("v/mid");
    expect(doc.profiles.ens.third_model).toBeUndefined();
    // Every benchmarked tool got its winner.
    expect(doc.profiles.ens.tool_models.code_task).toBe("v/cheap");
    expect(doc.profiles.ens.tool_models.security_scan).toBe("v/cheap");
    // A requirement-gated tool was NOT written — it has nothing proven to write.
    expect(doc.profiles.ens.tool_models.chat).toBeUndefined();
    // Untouched keys survive.
    expect(doc.profiles.ens.api_key).toBe("sk-test-literal");
    expect(r.toolsUpdated).toBe(5);
  });

  it("does NOT write a tool whose gate found no eligible same-or-cheaper passer", async () => {
    const { deps } = spyDeps({
      runToolBenchmark: async () => ({
        recommendedModelId: "v/incumbent",
        changed: false,
        eligibleCount: 0, // the "recommendation" IS the incumbent — writing it would lie
        costUsd: 0,
        reportPath: "",
      }),
    });
    const r = await runUpdateAll(baseOpts(), deps);
    const doc = yamlParse(readFileSync(settingsPath, "utf-8"));
    expect(doc.profiles.ens.tool_models).toBeUndefined();
    expect(r.toolsUpdated).toBe(0);
    expect(r.tools.find((t) => t.tool === "code_task")?.note).toMatch(/no eligible same-or-cheaper/);
  });

  it("leaves the ensemble ALONE when the pick cannot be satisfied — no half-picked write", async () => {
    const { deps } = spyDeps({
      runEnsembleSweep: async () => ({
        picks: [],
        pickError: "only 1 model cleared minMeanF1=0.95, need 2",
        passingFreeIds: [],
        modelsRun: 3,
        passers: 1,
        costUsd: 0,
        reportPath: "",
      }),
    });
    const r = await runUpdateAll(baseOpts(), deps);
    expect(r.ensemble?.written).toBe(false);
    expect(r.ensemble?.note).toMatch(/NOT written/);
    const doc = yamlParse(readFileSync(settingsPath, "utf-8"));
    expect(doc.profiles.ens.model).toBe("v/incumbent"); // untouched
  });

  // ── FREE mode: the free-models search + the $0 guarantee ─────────────────

  it("--free performs the FREE-MODELS SEARCH and rewrites free_models — no hand-editing", async () => {
    const { deps } = spyDeps();
    const r = await runUpdateAll(baseOpts({ mode: "free", budgetUsd: 0 }), deps);

    expect(r.ok).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect(r.freePool?.written).toBe(true);
    // The pool BECAME the ':free' models discovered from the live catalog and passed.
    expect(r.freePool?.pool.sort()).toEqual(["v/alpha:free", "v/beta:free"]);

    const doc = yamlParse(readFileSync(settingsPath, "utf-8"));
    expect(doc.profiles.ens.free_models.sort()).toEqual(["v/alpha:free", "v/beta:free"]);
    // Free mode only ever benchmarks zero-cost models.
    for (const t of r.tools.filter((x) => x.gate === "benchmark-proven")) {
      expect(t.winner?.endsWith(":free")).toBe(true);
    }
  });

  it("--free runs on a $0 budget and cannot spend: the estimate itself is $0", async () => {
    const { deps } = spyDeps();
    const r = await runUpdateAll(baseOpts({ mode: "free", budgetUsd: 0 }), deps);
    // A zero-priced model contributes nothing to the estimate, so the pre-flight check
    // can never abort a free run — and nothing can ever be billed for one.
    expect(r.estimatedUsd).toBe(0);
    expect(r.spentUsd).toBe(0);
    expect(r.aborted).toBeNull();
    const md = readFileSync(r.reportPath, "utf-8");
    expect(md).toContain("$0 by construction");
  });

  it("--free REFUSES to run when a configured free_models id is actually PRICED", async () => {
    // A "free" pool entry the catalog charges for would silently bill on every call.
    const { deps, toolCalls } = spyDeps();
    const r = await runUpdateAll(
      baseOpts({ mode: "free", configuredFreeModels: ["v/mid"] }), // v/mid costs money
      deps,
    );
    expect(r.ok).toBe(false);
    expect(r.aborted).toMatch(/NOT priced at \$0/);
    expect(toolCalls).toHaveLength(0); // nothing ran
    expect(r.spentUsd).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(SETTINGS); // nothing written
  });

  it("--free EXCLUDES a zero-cost NON-':free' router/pseudo-model from EVERY consumer (openrouter/free regression)", async () => {
    // THE BUG: 'openrouter/free' is priced $0, so resolveFreePool auto-discovers it into the
    // pool — but it lacks the ':free' suffix the send-time guard assertFreeOnlyModel requires,
    // so a real --free run aborted the entire multi-tool sweep at its first send. Fix A drops
    // it BEFORE the pool reaches the ensemble sweep or any per-tool benchmark.
    const ROUTER = model("openrouter/free", 0, 0); // zero-cost ROUTER pseudo-model, NO ':free' suffix
    let ensembleModels: string[] = [];
    const toolModels: string[][] = [];
    const { deps } = spyDeps({
      fetchCatalog: async () => [...CATALOG, ROUTER],
      runEnsembleSweep: async ({ models, topN }) => {
        ensembleModels = models;
        return {
          picks: models.slice(0, topN).map((id) => ({
            modelId: id,
            meanF1: 1,
            actualCost: 0,
            latencyMs: 1,
            inputDollarsPerMillion: 0,
            outputDollarsPerMillion: 0,
          })),
          pickError: null,
          passingFreeIds: models.filter((m) => m.endsWith(":free")),
          modelsRun: models.length,
          passers: models.length,
          costUsd: 0,
          reportPath: join(root, "sweep.md"),
        };
      },
      runToolBenchmark: async ({ tool, models }) => {
        toolModels.push([...models]);
        return {
          recommendedModelId: models[0] ?? "v/incumbent",
          changed: true,
          eligibleCount: models.length,
          costUsd: 0,
          reportPath: join(root, `${tool}.md`),
        };
      },
    });
    const r = await runUpdateAll(baseOpts({ mode: "free", budgetUsd: 0 }), deps);

    expect(r.ok).toBe(true);
    // The ensemble sweep sees ONLY the ':free' ids — the router pseudo-model is gone.
    expect(ensembleModels).not.toContain("openrouter/free");
    expect(ensembleModels.sort()).toEqual(["v/alpha:free", "v/beta:free"]);
    // Every per-tool benchmark's candidate set is likewise router-free.
    expect(toolModels.length).toBeGreaterThan(0);
    for (const models of toolModels) expect(models).not.toContain("openrouter/free");
    // And nothing non-':free' can leak into the written free_models pool.
    for (const id of r.freePool?.pool ?? []) expect(id.endsWith(":free")).toBe(true);
  });

  it("a per-tool benchmark that THROWS is recorded ERRORED and the sweep still completes over the remaining tools", async () => {
    // RESILIENCE (Fix B): one tool's benchmark throwing (e.g. a cost-safety guard throw from
    // inside its per-model judge) must NOT abort the whole --update-all sweep. Simulate the
    // first per-tool benchmark throwing; the rest must still run and the run must end [OK].
    let threw = false;
    const { deps, toolCalls } = spyDeps({
      runToolBenchmark: async ({ tool, models }) => {
        toolCalls.push(tool);
        if (!threw) {
          threw = true;
          throw new Error(
            "free_only cost-safety: refusing to send non-free model 'openrouter/free' to OpenRouter",
          );
        }
        return {
          recommendedModelId: models[0] ?? "v/incumbent",
          changed: true,
          eligibleCount: models.length,
          costUsd: 0,
          reportPath: join(root, `${tool}.md`),
        };
      },
    });
    const r = await runUpdateAll(baseOpts(), deps);

    // The whole sweep must NOT abort on one tool's throw.
    expect(r.ok).toBe(true);
    expect(r.aborted).toBeNull();
    // The loop continued past the throwing tool to at least one more.
    expect(toolCalls.length).toBeGreaterThan(1);
    // The throwing tool is recorded ERRORED (winner null, no write), not silently dropped.
    const erroredTool = r.tools.find((t) => t.tool === toolCalls[0]);
    expect(erroredTool?.winner).toBeNull();
    expect(erroredTool?.written).toBe(false);
    expect(erroredTool?.note).toMatch(/ERRORED/);
    // Every registered tool still has a row — the report stays complete.
    expect(r.tools.map((t) => t.tool).sort()).toEqual(registeredTools().sort());
    // A tool AFTER the throw still produced a real winner.
    expect(r.tools.some((t) => t.winner !== null)).toBe(true);
  });

  // ── P4: the spend cap ────────────────────────────────────────────────────

  it("ABORTS on the pre-flight estimate — before a single call, $0 spent", async () => {
    const { deps, toolCalls } = spyDeps();
    // A cap far below what the plan could cost.
    const r = await runUpdateAll(baseOpts({ mode: "paid", budgetUsd: 0.000001 }), deps);

    expect(r.ok).toBe(false);
    expect(r.aborted).toMatch(/WORST-CASE pre-flight estimate .* exceeds the \$0\.00 cap/);
    expect(r.aborted).toMatch(/nothing was sent, \$0 spent/);
    // It tells the caller the exact flag value that would authorize the run — the
    // decision is informed and typed, never a shrug — and is honest that the bound is
    // pessimistic, so nobody reads it as a prediction of the real bill.
    expect(r.aborted).toMatch(/--budget-usd \d/);
    expect(r.aborted).toMatch(/real spend is typically far lower/);
    // No trailing period: the CLI appends ". Report: <path>" to this summary.
    expect(r.aborted?.endsWith(".")).toBe(false);
    expect(toolCalls).toHaveLength(0);
    expect(r.spentUsd).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(SETTINGS); // nothing written
  });

  it("the pre-flight estimate is real: it grows with the roster and the price", () => {
    const cheap = { inputDollarsPerMillion: 0.1, outputDollarsPerMillion: 0.2 };
    const dear = { inputDollarsPerMillion: 1.0, outputDollarsPerMillion: 2.0 };
    const free = { inputDollarsPerMillion: 0, outputDollarsPerMillion: 0 };

    const a = estimateWorkloadCostUsd(ENSEMBLE_WORKLOAD, cheap);
    const b = estimateWorkloadCostUsd(ENSEMBLE_WORKLOAD, dear);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a); // 10× the price ⇒ a bigger bound
    expect(estimateWorkloadCostUsd(ENSEMBLE_WORKLOAD, free)).toBe(0);
  });

  it("STOPS mid-sweep the moment ACTUAL spend crosses the cap — remaining tools are SKIPPED, not silently run", async () => {
    // END-TO-END through the REAL budget guard: the orchestrator hands each runner a
    // BUDGETED fetch, the runner uses it, the provider bills, and the REAL SpendLedger
    // trips. Nothing about the cap is faked here — only the HTTP wire is.
    let httpCalls = 0;
    const httpFetch: FetchImpl = async () => {
      httpCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        // 20M prompt tokens: at v/cheap's $0.1/M that is $2.00 of REAL spend per call —
        // FAR more than the tiny request reserved. This is the provider-overbills case,
        // the one the trip latch exists for: we cannot un-spend it, but we can make sure
        // it happens exactly ONCE.
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: "{}" } }],
            usage: { prompt_tokens: 20_000_000, completion_tokens: 0 },
          }),
      };
    };

    const ranTools: string[] = [];
    const { deps } = spyDeps({
      httpFetch,
      // Each tool benchmark makes ONE real (budgeted) call, exactly as a runner would.
      runToolBenchmark: async ({ tool, models, fetchImpl }) => {
        ranTools.push(tool);
        await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {},
          body: JSON.stringify({
            model: models[0] ?? "v/cheap",
            messages: [{ role: "user", content: "x" }],
            max_tokens: 100,
          }),
        });
        return {
          recommendedModelId: models[0] ?? "v/incumbent",
          changed: true,
          eligibleCount: 1,
          costUsd: 0,
          reportPath: "",
        };
      },
    });

    // Cap $5: comfortably above the pre-flight estimate (so the run STARTS), but the
    // 3rd call's actual spend ($6 cumulative) crosses it.
    const r = await runUpdateAll(baseOpts({ mode: "paid", budgetUsd: 5 }), deps);

    expect(r.ok).toBe(false);
    expect(r.aborted).toMatch(/SPEND CAP/);

    // It stopped ON the crossing call. Three calls billed $2 each = $6; the 4th and 5th
    // tools were never run. THAT is the difference between a cap and a suggestion — a
    // silent-continue would have billed $10.
    expect(ranTools).toHaveLength(3);
    expect(httpCalls).toBe(3);
    expect(r.spentUsd).toBeCloseTo(6, 6);

    // Every tool that never ran is reported as SKIPPED — never as passing, never silently.
    const skipped = r.tools.filter((t) => t.note.includes("SKIPPED") || t.note.includes("ABORTED"));
    expect(skipped).toHaveLength(2);
    for (const t of skipped) {
      expect(t.winner).toBeNull();
      expect(t.written).toBe(false);
      expect(t.benchmarkedModels).toBe(0);
    }
  });

  // ── --dry-run ────────────────────────────────────────────────────────────

  it("--dry-run prints the plan + the estimate and spends NOTHING and writes NOTHING", async () => {
    const spy = spyDeps();
    const r = await runUpdateAll(baseOpts({ mode: "paid", dryRun: true }), spy.deps);

    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.spentUsd).toBe(0);
    expect(r.estimatedUsd).toBeGreaterThan(0); // a real number, not a placeholder
    expect(spy.toolCalls).toHaveLength(0); // no benchmark ran
    expect(spy.sweepCalls).toBe(0); // no sweep ran
    expect(readFileSync(settingsPath, "utf-8")).toBe(SETTINGS); // byte-identical
    expect(r.summary).toMatch(/dry-run — nothing sent, nothing written/);
    expect(r.summary).toMatch(/worst-case estimate \$/);
    // Every tool with its OWN sweep is listed with what it WOULD have cost. (mass_scout
    // is proven by the ensemble sweep, not a per-tool one, so it carries the ensemble
    // note instead — see the "accounts for EVERY registered tool" test.)
    const perToolSweeps = r.tools.filter(
      (x) => x.gate === "benchmark-proven" && x.benchmark !== "keyword-classification",
    );
    expect(perToolSweeps).toHaveLength(5);
    for (const t of perToolSweeps) {
      expect(t.note).toMatch(/dry-run — would benchmark \d+ model\(s\), worst case \$/);
      expect(t.written).toBe(false);
    }
    // …and nothing is written for ANY tool under dry-run.
    for (const t of r.tools) expect(t.written).toBe(false);
    expect(existsSync(r.reportPath)).toBe(true);
  });

  // ── The final line the slash command prints verbatim ─────────────────────

  it("ends with one machine-readable summary carrying scanned/qualified/benchmarked/updated/spend", async () => {
    const { deps } = spyDeps();
    const r = await runUpdateAll(baseOpts(), deps);
    expect(r.summary).toMatch(
      /paid refresh complete: \d+ scanned \/ \d+ qualified \/ \d+ benchmarked, 6 benchmark-proven \+ 5 requirement-gated tool\(s\), \d+ tool\(s\) updated, \$[\d.]+ spent of the \$[\d.]+ cap/,
    );
    expect(r.modelsScanned).toBe(CATALOG.length);
  });
});
