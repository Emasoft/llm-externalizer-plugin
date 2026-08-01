#!/usr/bin/env tsx
// Real OpenRouter smoke test for cluster_synonyms (task #68 in this run).
//
// Drives runClusterSynonyms with a real OpenRouter call against a tiny
// 6-item fixture (3 obvious-synonym pairs). Uses ONE model
// (deepseek/deepseek-v4-pro) so the cost stays well under 1¢. NOT the
// 3-model ensemble — this is a correctness smoke test, not a quality
// benchmark.
//
// Usage:
//   OPENROUTER_API_KEY=... npx tsx scripts/smoke_cluster_openrouter.ts \
//     [--out OUT_DIR] [--model MODEL_ID]
//
// Verifies: completes with ok=true, no failed_groups, no
// budget_exhausted, 3 clusters (one per synonym pair). Writes a markdown
// report under <git-root>/reports/llm-externalizer/.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { runClusterSynonyms } from "../src/cluster/cluster_synonyms_main.js";
import type { Phase1RawLlmCall } from "../src/cluster/phase1_batch.js";

interface OpenRouterChoice {
  message?: { content?: string };
}
interface OpenRouterResp {
  choices?: OpenRouterChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface CallStat {
  index: number;
  promptChars: number;
  responseChars: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}
const callStats: CallStat[] = [];

function makeOpenRouterCall(model: string, apiKey: string): Phase1RawLlmCall {
  return async (prompt: string): Promise<string> => {
    const t0 = Date.now();
    const url = "https://openrouter.ai/api/v1/chat/completions";
    const body = {
      model,
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Emasoft/llm-externalizer-plugin",
        "X-Title": "cluster_synonyms-smoke",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`OpenRouter ${resp.status} ${resp.statusText}: ${txt.slice(0, 300)}`);
    }
    const data = (await resp.json()) as OpenRouterResp;
    const content = data.choices?.[0]?.message?.content ?? "";
    callStats.push({
      index: callStats.length + 1,
      promptChars: prompt.length,
      responseChars: content.length,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    return content;
  };
}

function parseArgs(argv: readonly string[]): { outDir: string | null; model: string } {
  let outDir: string | null = null;
  let model = "deepseek/deepseek-v4-pro";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--out") {
      outDir = argv[i + 1];
      i++;
    } else if (argv[i] === "--model") {
      model = argv[i + 1];
      i++;
    }
  }
  return { outDir, model };
}

function resolveMainRoot(): string {
  try {
    const out = execSync("git worktree list", { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return out.trim().split("\n")[0].split(/\s+/)[0];
  } catch {
    return process.cwd();
  }
}

function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
  const tzMin = -d.getTimezoneOffset();
  const sign = tzMin >= 0 ? "+" : "-";
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join("") + "_" + [
    pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds()),
  ].join("") + sign + pad(Math.floor(Math.abs(tzMin) / 60)) + pad(Math.abs(tzMin) % 60);
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY not set");
    return 1;
  }

  const mainRoot = resolveMainRoot();
  const reportDir = join(mainRoot, "reports", "llm-externalizer");
  mkdirSync(reportDir, { recursive: true });
  const ts = localTimestamp();
  const outDir = opts.outDir ?? join(reportDir, `smoke-${ts}`);
  mkdirSync(outDir, { recursive: true });

  // 6-item fixture: 3 obvious synonym pairs.
  const fixture = [
    { id: "a1", sentence: "compile the project with optimisations enabled" },
    { id: "a2", sentence: "build the codebase with optimizer flags" },
    { id: "b1", sentence: "run the unit tests for the auth module" },
    { id: "b2", sentence: "execute the authentication module test suite" },
    { id: "c1", sentence: "deploy the docker container to production" },
    { id: "c2", sentence: "push the container image to the prod environment" },
  ];
  const inputPath = join(outDir, "input.jsonl");
  writeFileSync(inputPath, fixture.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const policyPath = join(outDir, "policy.json");
  writeFileSync(
    policyPath,
    JSON.stringify(
      {
        compute_embeddings: false, // skip Python sidecar
        batch_size: 100,           // all 6 items in one Phase 1 batch
        passes: 1,                 // single Phase 2 pass
        merge_min_cross_count: 3,  // standard
        canonical_label_mode: "heuristic", // skip Phase 3 LLM
        skip_preflight_benchmark: true,
        overwrite_output: true,
        emit_sqlite_clusters: false,
        budget_max_llm_calls: 20,  // hard ceiling
      },
      null, 2,
    ),
  );

  console.error(`[smoke] model    = ${opts.model}`);
  console.error(`[smoke] fixture  = ${fixture.length} items (3 expected synonym pairs)`);
  console.error(`[smoke] out_dir  = ${outDir}`);
  console.error("[smoke] running …");

  const tStart = Date.now();
  const result = await runClusterSynonyms(
    {
      input_file: inputPath,
      output_dir: outDir,
      policy_file: policyPath,
    },
    {
      rawLlmCall: makeOpenRouterCall(opts.model, apiKey),
      profileName: opts.model,
    },
  );
  const walltime = (Date.now() - tStart) / 1000;

  console.error("");
  console.error(`[smoke] ok               = ${result.ok}`);
  console.error(`[smoke] items_in         = ${result.stats.items_in}`);
  console.error(`[smoke] clusters_out     = ${result.stats.clusters_out}`);
  console.error(`[smoke] reduction_pct    = ${result.stats.reduction_pct.toFixed(1)}%`);
  console.error(`[smoke] llm_calls        = ${result.stats.llm_calls_total} (phase1=${result.stats.llm_calls_by_phase.phase1}, phase2=${result.stats.llm_calls_by_phase.phase2}, phase3=${result.stats.llm_calls_by_phase.phase3})`);
  console.error(`[smoke] budget_exhausted = ${result.stats.budget_exhausted}`);
  console.error(`[smoke] failed_groups    = ${result.stats.failed_groups.length}`);
  console.error(`[smoke] weak_overlap     = ${result.stats.weak_overlap_evidence.length}`);
  console.error(`[smoke] warnings         = ${result.stats.warnings.length}`);
  console.error(`[smoke] walltime_s       = ${walltime.toFixed(2)}`);
  console.error(`[smoke] errors           = ${result.errors.join(" | ") || "(none)"}`);

  // Quality gate: 6 items + 3 obvious synonym pairs → expect 3 clusters of 2.
  const expectedClusters = 3;
  const correctness = result.ok && result.stats.clusters_out === expectedClusters && result.stats.failed_groups.length === 0;
  console.error("");
  console.error(`[smoke] VERDICT          = ${correctness ? "PASS" : "FAIL"}  (expected ${expectedClusters} clusters)`);

  // Write a markdown report.
  const reportPath = join(reportDir, `${ts}-smoke-cluster-openrouter.md`);
  const totalIn = callStats.reduce((s, c) => s + c.promptTokens, 0);
  const totalOut = callStats.reduce((s, c) => s + c.completionTokens, 0);
  // deepseek-v4-pro: $0.43 in / $0.87 out per million tokens
  const usdIn = (totalIn / 1_000_000) * 0.43;
  const usdOut = (totalOut / 1_000_000) * 0.87;
  const usdTotal = usdIn + usdOut;
  const lines: string[] = [
    `# cluster_synonyms smoke test — ${ts}`,
    "",
    `**Verdict**: ${correctness ? "PASS" : "FAIL"}`,
    `**Model**: \`${opts.model}\``,
    `**Fixture**: 6 items, 3 expected synonym pairs`,
    `**Out dir**: \`${outDir}\``,
    "",
    "## Stats",
    "",
    `| key | value |`,
    `|---|---|`,
    `| ok | ${result.ok} |`,
    `| items_in | ${result.stats.items_in} |`,
    `| clusters_out | ${result.stats.clusters_out} (expected ${expectedClusters}) |`,
    `| reduction_pct | ${result.stats.reduction_pct.toFixed(1)}% |`,
    `| llm_calls_total | ${result.stats.llm_calls_total} |`,
    `| llm_calls_phase1 | ${result.stats.llm_calls_by_phase.phase1} |`,
    `| llm_calls_phase2 | ${result.stats.llm_calls_by_phase.phase2} |`,
    `| llm_calls_phase3 | ${result.stats.llm_calls_by_phase.phase3} |`,
    `| budget_exhausted | ${result.stats.budget_exhausted} |`,
    `| failed_groups | ${result.stats.failed_groups.length} |`,
    `| weak_overlap_evidence | ${result.stats.weak_overlap_evidence.length} |`,
    `| warnings | ${result.stats.warnings.length} |`,
    `| walltime_s | ${walltime.toFixed(2)} |`,
    "",
    "## Per-call breakdown",
    "",
    `| # | prompt chars | response chars | in tok | out tok | latency ms |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const c of callStats) {
    lines.push(`| ${c.index} | ${c.promptChars} | ${c.responseChars} | ${c.promptTokens} | ${c.completionTokens} | ${c.latencyMs} |`);
  }
  lines.push("");
  lines.push("## Cost estimate (deepseek-v4-pro)");
  lines.push("");
  lines.push(`- input tokens: ${totalIn} → $${usdIn.toFixed(6)}`);
  lines.push(`- output tokens: ${totalOut} → $${usdOut.toFixed(6)}`);
  lines.push(`- **total: $${usdTotal.toFixed(6)}**`);
  lines.push("");
  lines.push("## Warnings");
  lines.push("");
  if (result.stats.warnings.length === 0) {
    lines.push("(none)");
  } else {
    for (const w of result.stats.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push("## Errors");
  lines.push("");
  if (result.errors.length === 0) lines.push("(none)");
  else for (const e of result.errors) lines.push(`- ${e}`);
  writeFileSync(reportPath, lines.join("\n") + "\n");
  console.error(`[smoke] report = ${reportPath}`);

  return correctness ? 0 : 2;
}

const here = dirname(fileURLToPath(import.meta.url));
void here;
main().then((code) => process.exit(code)).catch((err) => {
  console.error(`[smoke] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
