#!/usr/bin/env node
/**
 * Benchmark CLI entry point.
 *
 * Usage:
 *   node dist/benchmark.js [--include MODEL_ID]... [--dry-run] [--report PATH]
 *
 * Flow:
 *   1. Build ground truth from fixtures/*.ts
 *   2. Fetch OpenRouter `/api/v1/models?category=programming`
 *   3. Apply the cost + capability filter → candidates
 *   4. Add explicit `--include MODEL_ID` baselines (bypass the filter)
 *   5. For each model, call OpenRouter with the fixtures + strict JSON schema
 *   6. Score each result against ground truth
 *   7. Emit a markdown report under reports/benchmark/<ts>-results.md
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { buildGroundTruth, BENCHMARK_KEYWORDS } from "./ground-truth.js";
import {
  DEFAULT_CRITERIA,
  buildBenchmarkRoster,
  fetchProgrammingModels,
  type QualifiedModel,
} from "./discover.js";
import { runBenchmarkOnModel, type RunOutcome } from "./runner.js";
import { scoreRun, type ModelScore } from "./score.js";
import { renderReport, renderJson } from "./report.js";

interface CliOptions {
  includeIds: string[];
  dryRun: boolean;
  reportPath: string | null;
  jsonPath: string | null;
  reasoningEffort: "low" | "medium" | "high" | undefined;
  seed: number | undefined;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = {
    includeIds: [],
    dryRun: false,
    reportPath: null,
    jsonPath: null,
    reasoningEffort: undefined,
    seed: undefined,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--include") opts.includeIds.push(argv[++i]);
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--report") opts.reportPath = argv[++i];
    else if (a === "--json") opts.jsonPath = argv[++i];
    else if (a === "--reasoning") {
      const eff = argv[++i];
      if (eff !== "low" && eff !== "medium" && eff !== "high") {
        throw new Error(`--reasoning must be low|medium|high, got ${eff}`);
      }
      opts.reasoningEffort = eff;
    } else if (a === "--seed") opts.seed = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      "llm-ext-benchmark — score OpenRouter models on a TypeScript-AST classification task.",
      "",
      "Usage:",
      "  llm-ext-benchmark [--include MODEL_ID]... [--dry-run] [--report PATH]",
      "                   [--reasoning low|medium|high] [--seed N]",
      "",
      "Flags:",
      "  --include ID      Add a model ID that bypasses the cost filter (repeatable).",
      "                    Use this to benchmark the current production ensemble.",
      "  --dry-run | -n    Print the resolved roster and exit; no API calls made.",
      "  --report PATH     Write the markdown report to PATH (default: auto-timestamped).",
      "  --json PATH       Write the machine-readable JSON sidecar to PATH.",
      "                    Always also written to ~/.llm-externalizer/benchmark-results.json.",
      "  --reasoning EFF   Pass reasoning.effort to each model. Default: model default.",
      "  --seed N          Fixed seed (models that support it will respect it).",
      "",
      "Criteria applied to candidates (non-baseline):",
      `  - category = ${DEFAULT_CRITERIA.category}`,
      `  - context_length >= ${DEFAULT_CRITERIA.minContextTokens.toLocaleString()}`,
      `  - max_completion_tokens >= ${DEFAULT_CRITERIA.minOutputTokens.toLocaleString()}`,
      `  - structured_outputs or response_format supported`,
      `  - reasoning or include_reasoning supported`,
      `  - $/M in <= ${DEFAULT_CRITERIA.maxInputDollarsPerMillion.toFixed(2)}`,
      `  - $/M out <= ${DEFAULT_CRITERIA.maxOutputDollarsPerMillion.toFixed(2)}`,
      `  - :free tier excluded`,
      "",
      "API key resolution order: OPENROUTER_API_KEY env, then $CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY.",
    ].join("\n"),
  );
}

function resolveApiKey(): string {
  const k = process.env.OPENROUTER_API_KEY || process.env.CLAUDE_PLUGIN_OPTION_OPENROUTER_API_KEY;
  if (!k) {
    throw new Error(
      "OPENROUTER_API_KEY not set. Export it in your shell, or set the plugin option 'openrouter_api_key' via Claude Code's /plugin configure.",
    );
  }
  return k;
}

function resolveFixturesDir(): string {
  // __dirname for ES modules
  const here = dirname(fileURLToPath(import.meta.url));
  // When bundled to dist/benchmark.js, fixtures sit at ../src/benchmark/fixtures
  // When running from src/benchmark/index.ts (unbundled), they sit alongside
  // as ./fixtures. Try both.
  const candidates = [
    join(here, "fixtures"),
    join(here, "..", "src", "benchmark", "fixtures"),
    join(here, "..", "..", "src", "benchmark", "fixtures"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "file-01.ts"))) return c;
  }
  throw new Error(`Could not locate benchmark fixtures. Tried:\n  ${candidates.join("\n  ")}`);
}

function resolveMainRoot(): string {
  try {
    const out = execSync("git worktree list", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    const first = out.trim().split("\n")[0];
    return first.split(/\s+/)[0];
  } catch {
    return resolve(".");
  }
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);
  const fixturesDir = resolveFixturesDir();
  const truth = buildGroundTruth(fixturesDir, BENCHMARK_KEYWORDS);

  console.error(`[benchmark] Ground truth built from ${truth.fixtures.length} files, ${truth.allFunctions.length} top-level functions.`);
  for (let i = 0; i < 3; i++) {
    console.error(`  kw${i + 1} "${truth.keywords[i]}": ${truth.keywordFunctions[i].length} expected matches`);
  }
  console.error(`  noise: ${truth.noiseFunctions.length}`);

  console.error("[benchmark] Fetching OpenRouter model list …");
  // Fetch the category-filtered list for candidates and the full list for
  // baseline lookups: baselines may be outside the programming category
  // (e.g. x-ai/grok-4.1-fast is classified under general-purpose models
  // but is still in the production ensemble).
  const [categoryModels, allModels] = await Promise.all([
    fetchProgrammingModels(DEFAULT_CRITERIA.category),
    opts.includeIds.length > 0 ? fetchProgrammingModels() : Promise.resolve([]),
  ]);
  console.error(
    `[benchmark] ${categoryModels.length} models in category=${DEFAULT_CRITERIA.category}` +
      (allModels.length > 0 ? `; ${allModels.length} total for baseline lookup` : ""),
  );

  // buildBenchmarkRoster filters the candidate pool and looks up
  // baselines in the baseline pool (which may be broader).
  const baselineLookup = allModels.length > 0 ? allModels : categoryModels;
  const { candidates, baselines } = buildBenchmarkRoster(
    categoryModels,
    DEFAULT_CRITERIA,
    opts.includeIds,
    baselineLookup,
  );
  console.error(`[benchmark] Roster: ${candidates.length} candidate(s), ${baselines.length} baseline(s).`);
  for (const m of candidates) {
    console.error(`  CAND  ${m.id.padEnd(40)} ctx=${m.contextTokens}  in=$${m.inputDollarsPerMillion.toFixed(3)}  out=$${m.outputDollarsPerMillion.toFixed(3)}`);
  }
  for (const m of baselines) {
    console.error(`  BASE  ${m.id.padEnd(40)} ctx=${m.contextTokens}  in=$${m.inputDollarsPerMillion.toFixed(3)}  out=$${m.outputDollarsPerMillion.toFixed(3)}`);
  }

  if (opts.dryRun) {
    console.error("[benchmark] --dry-run: roster only, exiting before any API call.");
    return 0;
  }

  const apiKey = resolveApiKey();
  const roster: Array<{ model: QualifiedModel; isBaseline: boolean }> = [
    ...candidates.map((m) => ({ model: m, isBaseline: false })),
    ...baselines.map((m) => ({ model: m, isBaseline: true })),
  ];

  const results = new Map<
    string,
    { model: QualifiedModel; outcome: RunOutcome; score: ModelScore | null; isBaseline: boolean }
  >();

  // Sequential rather than parallel — the benchmark is small, and serialising
  // avoids stacking up rate-limit hits on a single OpenRouter account.
  for (const { model, isBaseline } of roster) {
    console.error(`[benchmark] Running ${model.id} …`);
    const outcome = await runBenchmarkOnModel(model, truth.keywords, truth.fixtures, {
      apiKey,
      httpReferer: "https://github.com/Emasoft/llm-externalizer-plugin",
      xTitle: "llm-externalizer-benchmark",
      reasoningEffort: opts.reasoningEffort,
      seed: opts.seed,
    });
    let score: ModelScore | null = null;
    if (outcome.ok) {
      score = scoreRun(outcome, truth);
      console.error(
        `[benchmark]   ${outcome.ok ? "OK" : "ERR"} — pass=${score.pass}  meanF1=${(score.meanF1 * 100).toFixed(1)}%  ${outcome.inputTokens} in / ${outcome.outputTokens} out tok  ${outcome.latencyMs.toFixed(0)}ms`,
      );
    } else {
      console.error(`[benchmark]   ERR — ${outcome.error}`);
    }
    results.set(model.id, { model, outcome, score, isBaseline });
  }

  const reportPath = opts.reportPath ?? buildReportPath();
  const timestamp = new Date().toISOString();
  const reportInput = {
    timestamp,
    truth,
    rosterCandidates: candidates,
    rosterBaselines: baselines,
    results,
  };

  const markdown = renderReport(reportInput);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, markdown, "utf-8");
  console.error(`[benchmark] Report: ${reportPath}`);

  // JSON sidecar. Always write to the well-known cache path
  // (~/.llm-externalizer/benchmark-results.json) so downstream commands
  // like /llm-externalizer:llm-externalizer-change-model can pick it up
  // without needing to be told where. --json PATH adds a second copy at
  // the user-chosen location.
  const json = renderJson(reportInput);
  const cacheJsonPath = join(homedir(), ".llm-externalizer", "benchmark-results.json");
  mkdirSync(dirname(cacheJsonPath), { recursive: true });
  writeFileSync(cacheJsonPath, json, "utf-8");
  console.error(`[benchmark] JSON cache: ${cacheJsonPath}`);
  if (opts.jsonPath) {
    mkdirSync(dirname(opts.jsonPath), { recursive: true });
    writeFileSync(opts.jsonPath, json, "utf-8");
    console.error(`[benchmark] JSON (user-path): ${opts.jsonPath}`);
  }

  // Summary for easy grep-ing
  const passers = [...results.values()].filter((r) => r.score?.pass).length;
  console.error(`[benchmark] ${passers}/${results.size} models passed.`);
  return 0;
}

function buildReportPath(): string {
  const root = resolveMainRoot();
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMin);
  const tz = `${offsetSign}${pad(Math.floor(offsetAbs / 60))}${pad(offsetAbs % 60)}`;
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${tz}`;
  return join(root, "reports", "benchmark", `${ts}-model-comparison.md`);
}

main().catch((err) => {
  console.error("[benchmark] fatal:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
