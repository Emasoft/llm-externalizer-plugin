/**
 * Markdown report generator for the benchmark.
 *
 * Produces a single .md file summarising every model's result. The
 * report is self-contained — no JS or JSON attachments — so the user
 * can paste it into a PR description or a release note.
 */

import type { GroundTruth } from "./ground-truth.js";
import type { QualifiedModel } from "./discover.js";
import type { RunOutcome, RunResult } from "./runner.js";
import type { ModelScore } from "./score.js";

export interface ReportInput {
  timestamp: string;
  truth: GroundTruth;
  rosterCandidates: readonly QualifiedModel[];
  rosterBaselines: readonly QualifiedModel[];
  results: ReadonlyMap<string, { model: QualifiedModel; outcome: RunOutcome; score: ModelScore | null; isBaseline: boolean }>;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function usdCost(model: QualifiedModel, run: RunResult): number {
  // Reasoning tokens are charged as output tokens by OpenRouter.
  const inUsd = (run.inputTokens / 1_000_000) * model.inputDollarsPerMillion;
  const outUsd = (run.outputTokens / 1_000_000) * model.outputDollarsPerMillion;
  return inUsd + outUsd;
}

/**
 * Machine-readable JSON sidecar to the markdown report. Consumed by
 * `llm-externalizer-change-model` (and any other programmatic caller)
 * to build the model-selection menus and compute ensemble costs without
 * having to parse the markdown.
 *
 * The shape is deliberately flat — one object per model, every field
 * needed for the menu + cost math is at the top level. No nested score
 * objects, no transport state, no raw response body.
 */
export function renderJson(input: ReportInput): string {
  const results = [...input.results.values()].map((entry) => {
    const base = {
      modelId: entry.model.id,
      name: entry.model.name,
      isBaseline: entry.isBaseline,
      contextTokens: entry.model.contextTokens,
      maxOutputTokens: entry.model.maxOutputTokens,
      inputDollarsPerMillion: entry.model.inputDollarsPerMillion,
      outputDollarsPerMillion: entry.model.outputDollarsPerMillion,
      supportsStructured: entry.model.supportsStructured,
      supportsReasoning: entry.model.supportsReasoning,
    };
    if (!entry.outcome.ok) {
      return {
        ...base,
        ok: false,
        error: entry.outcome.error,
        httpStatus: entry.outcome.httpStatus ?? null,
        latencyMs: entry.outcome.latencyMs,
      };
    }
    const run = entry.outcome;
    const score = entry.score!;
    return {
      ...base,
      ok: true,
      pass: score.pass,
      meanF1: score.meanF1,
      kw1F1: score.perKeyword[0].f1,
      kw2F1: score.perKeyword[1].f1,
      kw3F1: score.perKeyword[2].f1,
      schemaCompliant: run.schemaCompliant,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      reasoningTokens: run.reasoningTokens,
      latencyMs: run.latencyMs,
      actualCost: usdCost(entry.model, run),
      providerFinishReason: run.providerFinishReason,
      hallucinatedNames: score.hallucinated,
    };
  });
  const payload = {
    timestamp: input.timestamp,
    keywords: input.truth.keywords,
    groundTruth: {
      kw1FunctionCount: input.truth.keywordFunctions[0].length,
      kw2FunctionCount: input.truth.keywordFunctions[1].length,
      kw3FunctionCount: input.truth.keywordFunctions[2].length,
      noiseFunctionCount: input.truth.noiseFunctions.length,
      totalFunctionCount: input.truth.allFunctions.length,
    },
    roster: {
      candidates: input.rosterCandidates.map((m) => m.id),
      baselines: input.rosterBaselines.map((m) => m.id),
    },
    results,
  };
  return JSON.stringify(payload, null, 2);
}

export function renderReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# OpenRouter model benchmark — ${input.timestamp}`);
  lines.push("");
  lines.push("Task: given 5 TypeScript files (71 top-level functions), classify which functions contain each of three literal keyword substrings. Ground truth is derived from the fixtures via the TypeScript compiler API.");
  lines.push("");
  lines.push("**Keywords**");
  for (let i = 0; i < input.truth.keywords.length; i++) {
    lines.push(`- kw${i + 1}: \`${input.truth.keywords[i]}\` — ${input.truth.keywordFunctions[i].length} functions`);
  }
  lines.push(`- noise (no keyword): ${input.truth.noiseFunctions.length} functions`);
  lines.push(`- total: ${input.truth.allFunctions.length} functions across 5 files`);
  lines.push("");

  lines.push("## Results");
  lines.push("");
  lines.push(
    "| Model | Pass | Schema | kw1 F1 | kw2 F1 | kw3 F1 | Mean F1 | In tok | Out tok | Reasoning tok | Cost | Latency |",
  );
  lines.push(
    "|-------|------|--------|--------|--------|--------|---------|--------|---------|---------------|------|---------|",
  );

  const rows: Array<{ key: string; line: string; meanF1: number; baseline: boolean }> = [];
  for (const [id, entry] of input.results) {
    const tag = entry.isBaseline ? " _(baseline)_" : "";
    if (!entry.outcome.ok) {
      rows.push({
        key: id,
        line: `| \`${id}\`${tag} | ❌ error | – | – | – | – | – | – | – | – | – | ${entry.outcome.latencyMs.toFixed(0)}ms (${entry.outcome.error.slice(0, 60)}) |`,
        meanF1: -1,
        baseline: entry.isBaseline,
      });
      continue;
    }
    const run = entry.outcome;
    const score = entry.score!;
    const cost = usdCost(entry.model, run);
    const pass = score.pass ? "✅ PASS" : "❌ FAIL";
    const schema = run.schemaCompliant ? "✓" : "⚠ short names";
    rows.push({
      key: id,
      meanF1: score.meanF1,
      baseline: entry.isBaseline,
      line: [
        `| \`${id}\`${tag}`,
        pass,
        schema,
        pct(score.perKeyword[0].f1),
        pct(score.perKeyword[1].f1),
        pct(score.perKeyword[2].f1),
        pct(score.meanF1),
        String(run.inputTokens),
        String(run.outputTokens),
        String(run.reasoningTokens || "–"),
        `$${cost.toFixed(4)}`,
        `${run.latencyMs.toFixed(0)}ms`,
      ].join(" | ") + " |",
    });
  }
  // Rank by meanF1 desc, failures last, baselines kept in same table but tagged.
  rows.sort((a, b) => b.meanF1 - a.meanF1);
  for (const r of rows) lines.push(r.line);

  lines.push("");
  lines.push("## Per-keyword detail");
  lines.push("");
  for (const [id, entry] of input.results) {
    if (!entry.outcome.ok) continue;
    const score = entry.score!;
    lines.push(`### \`${id}\`${entry.isBaseline ? " _(baseline)_" : ""}`);
    lines.push("");
    for (let i = 0; i < 3; i++) {
      const pk = score.perKeyword[i];
      lines.push(`**kw${i + 1} — \`${input.truth.keywords[i]}\` (F1 ${pct(pk.f1)}, P ${pct(pk.precision)}, R ${pct(pk.recall)})**`);
      lines.push("");
      if (pk.falsePositives.length) {
        lines.push(`- false positives: ${pk.falsePositives.map((n) => `\`${n}\``).join(", ")}`);
      }
      if (pk.falseNegatives.length) {
        lines.push(`- missed: ${pk.falseNegatives.map((n) => `\`${n}\``).join(", ")}`);
      }
      if (!pk.falsePositives.length && !pk.falseNegatives.length) {
        lines.push(`- exact match (${pk.truePositives.length}/${pk.expected.length})`);
      }
      lines.push("");
    }
    if (score.hallucinated.length) {
      lines.push(`- hallucinated (names not in any fixture): ${score.hallucinated.map((n) => `\`${n}\``).join(", ")}`);
      lines.push("");
    }
  }

  lines.push("## Roster");
  lines.push("");
  lines.push(`- Candidates (${input.rosterCandidates.length}): pass the cost + capability filter.`);
  lines.push(`- Baselines (${input.rosterBaselines.length}): included explicitly for comparison, not filter-qualified.`);
  lines.push("");
  lines.push("| Model | Role | Ctx | Max Out | $/M in | $/M out |");
  lines.push("|-------|------|-----|---------|--------|---------|");
  for (const m of input.rosterCandidates) {
    lines.push(`| \`${m.id}\` | candidate | ${m.contextTokens.toLocaleString()} | ${m.maxOutputTokens.toLocaleString()} | $${m.inputDollarsPerMillion.toFixed(2)} | $${m.outputDollarsPerMillion.toFixed(2)} |`);
  }
  for (const m of input.rosterBaselines) {
    const inP = isFinite(m.inputDollarsPerMillion) ? `$${m.inputDollarsPerMillion.toFixed(2)}` : "–";
    const outP = isFinite(m.outputDollarsPerMillion) ? `$${m.outputDollarsPerMillion.toFixed(2)}` : "–";
    lines.push(`| \`${m.id}\` | baseline | ${m.contextTokens.toLocaleString()} | ${m.maxOutputTokens.toLocaleString()} | ${inP} | ${outP} |`);
  }
  lines.push("");

  return lines.join("\n");
}
