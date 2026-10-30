/**
 * Scout-accuracy fixture + positional classifier (TRDD-FKAR9VPK D1).
 *
 * Lifted from calibrate-payload-size.test.ts (that test's fixture machinery is
 * file-internal, zero exports) and RESHAPED for mass-scout's real workload:
 * synthetic skill-file FRONTMATTER records -> known-good extracted category
 * labels, scored POSITIONALLY. The hand-crafted JSON Schema + direct-POST
 * classifier deliberately bypasses the scout pipeline: the fieldset DSL's
 * array_enum repair/dedup would collapse adjacent same-category outputs and
 * corrupt positional semantics (see the calibration test's header).
 *
 * The TWEET generator STAYS in the calibration test (A7); this module owns the
 * FRONTMATTER generator only.
 */

import type { FetchImpl } from "./scout";

/**
 * Bump whenever the fixture GENERATOR changes shape. The ledger hash covers
 * this constant, so a bump changes the datasetHash and invalidates every prior
 * verdict BY DESIGN: the next scout-accuracy run re-probes every candidate.
 */
export const SCOUT_ACCURACY_FIXTURE_VERSION = 1;

/** A7: accuracy denominator floor. A score over fewer records than this can
 *  hit 100% on too few positions to mean anything. */
export const MIN_FIXTURE_RECORDS = 40;

/** Default direct-POST base URL (the OpenRouter preset's defaultUrl; the
 *  /v1/chat/completions suffix is appended here, same as resolveConnection). */
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

const CHAT_COMPLETIONS_SUFFIX = "/v1/chat/completions";

// ── Categories + vocabulary ────────────────────────────────────────────

export const SCOUT_CATEGORIES = [
  "debugging",
  "testing",
  "deployment",
  "docs",
  "security",
  "performance",
  "refactoring",
  "tooling",
  "data",
  "ui",
] as const;
export type ScoutCategory = (typeof SCOUT_CATEGORIES)[number];

interface CategoryVocab {
  words: string[];
  tags: string[];
}

const VOCAB: Record<ScoutCategory, CategoryVocab> = {
  debugging: {
    words: [
      "breakpoint", "stacktrace", "watchpoint", "coredump", "debugger",
      "traceback", "repro", "heisenbug", "bisect", "logging", "assert",
      "symbol", "backtrace", "step-over", "inspection", "heap", "race",
      "deadlock", "exception", "failing", "flaky", "root-cause", "stack",
      "probe", "diagnose", "panic", "segfault", "watchdog",
    ],
    tags: ["#debugging", "#breakpoint", "#repro", "#traceback"],
  },
  testing: {
    words: [
      "unittest", "fixture", "mock", "stub", "coverage", "assertion",
      "regression", "integration", "e2e", "pytest", "vitest", "tdd",
      "suite", "hypothesis", "property-based", "golden", "snapshot",
      "matrix", "flaky-test", "smoke", "canary", "fuzz", "oracle",
      "testbed", "harness", "xunit", "spec", "double",
    ],
    tags: ["#testing", "#coverage", "#tdd", "#vitest"],
  },
  deployment: {
    words: [
      "deploy", "release", "rollback", "canary", "blue-green", "pipeline",
      "docker", "kubernetes", "helm", "terraform", "provision", "cluster",
      "staging", "production", "artifact", "registry", "image", "tag",
      "rollout", "orchestration", "service-mesh", "ingress", "replica",
      "autoscale", "uptime", "outage", "failover", "drift",
    ],
    tags: ["#deployment", "#kubernetes", "#release", "#rollout"],
  },
  docs: {
    words: [
      "readme", "changelog", "tutorial", "guide", "reference", "manual",
      "api-docs", "docstring", "style-guide", "onboarding", "faq",
      "glossary", "diagram", "specification", "admonition", "mkdocs",
      "markdown", "footnote", "sidebar", "landing-page", "howto",
      "cheatsheet", "appendix", "index", "crossref", "typo", "wording",
      "example",
    ],
    tags: ["#docs", "#readme", "#guide", "#markdown"],
  },
  security: {
    words: [
      "cve", "injection", "sanitizer", "escaping", "authn", "authz",
      "token", "secret", "vault", "harden", "threat-model", "audit",
      "pentest", "malware", "sandbox", "allowlist", "denylist", "nonce",
      "signature", "certificate", "tls", "rotate", "least-privilege",
      "exfiltration", "spoofing", "tampering", "repudiation", "disclosure",
    ],
    tags: ["#security", "#cve", "#audit", "#harden"],
  },
  performance: {
    words: [
      "latency", "throughput", "profiler", "bottleneck", "cache-hit",
      "memoize", "benchmark", "flamegraph", "hotpath", "alloc",
      "garbage-collection", "batching", "vectorize", "index-scan",
      "n+1", "lazy-load", "prefetch", "compression", "pooling",
      "budget", "percentile", "tail-latency", "jank", "regression-perf",
      "simd", "inlining", "branchless", "amortized",
    ],
    tags: ["#performance", "#latency", "#profiler", "#benchmark"],
  },
  refactoring: {
    words: [
      "extract-method", "inline", "rename", "move-class", "dead-code",
      "god-object", "coupling", "cohesion", "strategy", "adapter",
      "decorator", "simplify", "deduplicate", "split", "merge",
      "parameterize", "encapsulate", "bridge", "facade", "anti-pattern",
      "cyclomatic", "introduce-param", "guard-clause", "collapsing",
      "sprawling", "primitive-obsession", "feature-envy", "shotgun",
    ],
    tags: ["#refactoring", "#cleanup", "#dedup", "#simplify"],
  },
  tooling: {
    words: [
      "linter", "formatter", "cli", "flag", "subcommand", "builder",
      "bundler", "transpiler", "watcher", "repl", "scaffold", "generator",
      "template", "plugin-system", "hook", "extension", "toolchain",
      "sdk", "codemod", "migration-script", "changelog-tool", "script",
      "automation", "makefile", "taskfile", "runner", "wrapper", "shim",
    ],
    tags: ["#tooling", "#cli", "#linter", "#automation"],
  },
  data: {
    words: [
      "schema", "migration", "index", "query-planner", "normal-form",
      "denormalize", "etl", "pipeline-data", "warehouse", "columnar",
      "parquet", "jsonl", "csv", "sqlite", "postgres", "serde",
      "serialization", "primary-key", "foreign-key", "transaction",
      "isolation", "upsert", "vacuum", "partition", "shard", "ttl",
      "materialized-view", "cursor",
    ],
    tags: ["#data", "#schema", "#sql", "#etl"],
  },
  ui: {
    words: [
      "component", "props", "state", "hook-ui", "render", "layout",
      "accessibility", "aria", "focus-trap", "stylesheet", "tailwind",
      "responsive", "viewport", "dark-mode", "theming", "widget",
      "modal", "tooltip", "dropdown", "form", "validation-ui", "i18n",
      "skeleton", "virtualized", "scroll", "animation", "transition",
      "design-system",
    ],
    tags: ["#ui", "#component", "#a11y", "#css"],
  },
};

// ── Deterministic PRNG (mulberry32) ────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Fixture generation ─────────────────────────────────────────────────

export interface ScoutFixture {
  /** The concatenated fixture body sent to the model. */
  body: string;
  /** expected[i] is the category of record i — the positional ground truth. */
  expected: ScoutCategory[];
  /** Number of records (== expected.length). */
  recordCount: number;
}

/** One skill-file frontmatter record keyed by `(category, idx)`. Deterministic
 *  for a given seed. Record i starts with `name: skill-<i>` so the model can
 *  see which slot it fills (and we can audit predicted vs expected). */
function generateRecord(
  category: ScoutCategory,
  idx: number,
  rnd: () => number,
  tagsOverride?: string,
): string {
  const v = VOCAB[category];
  const descWords: string[] = [];
  const wordCount = 5 + (idx % 3); // 5..7 words
  for (let i = 0; i < wordCount; i++) {
    descWords.push(v.words[Math.floor(rnd() * v.words.length)]!);
  }
  // The calibration copy passes neutral tags (P6): the category hashtags would let a model copy the label.
  const tags = tagsOverride ?? v.tags.slice(0, 2 + (idx % 2)).join(" "); // 2..3 tags
  const name = `skill-${String(idx).padStart(6, "0")}`;
  const bodyWords: string[] = [];
  for (let i = 0; i < 4 + (idx % 2); i++) {
    bodyWords.push(v.words[Math.floor(rnd() * v.words.length)]!);
  }
  return [
    "---",
    `name: ${name}`,
    `description: ${descWords.join(" ")} -- ${tags}`,
    `version: 1.${idx % 10}.${idx % 3}`,
    "---",
    "",
    `# ${name}`,
    "",
    `${bodyWords.join(" ")}.`,
    "",
    "",
  ].join("\n");
}

/** Generate exactly `count` records. Record i has category
 *  `SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]` — the positional ground
 *  truth the scorer compares against. */
export function generateFixtureRecords(seed: number, count: number): ScoutFixture {
  const rnd = mulberry32(seed);
  const chunks: string[] = [];
  const expected: ScoutCategory[] = [];
  for (let i = 0; i < count; i++) {
    const cat = SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]!;
    chunks.push(generateRecord(cat, i, rnd));
    expected.push(cat);
  }
  const body = chunks.join("");
  return { body, expected, recordCount: expected.length };
}

/** The byte size of the MINIMUM fixture (A9b): exactly MIN_FIXTURE_RECORDS
 *  records. The PRNG is deterministic, so this is a stable constant. Skipped
 *  candidates are those whose clamped effective size falls below this — a
 *  degenerate (record-shrinking) fixture would make accuracy meaningless. */
export const MIN_FIXTURE_BYTES = Buffer.byteLength(
  generateFixtureRecords(1, MIN_FIXTURE_RECORDS).body,
  "utf-8",
);

/**
 * Generate the fixture at `targetBytes`. Deterministic for a given seed.
 * NEVER shrinks a record to fit the target (A9b): the walk stops at the first
 * full record that would overshoot, and the count is FLOORED at
 * MIN_FIXTURE_RECORDS so the accuracy denominator is always meaningful.
 */
export function generateFixture(seed: number, targetBytes: number): ScoutFixture {
  const rnd = mulberry32(seed);
  const chunks: string[] = [];
  const expected: ScoutCategory[] = [];
  let total = 0;
  let i = 0;
  while (i < MIN_FIXTURE_RECORDS || total < targetBytes) {
    const cat = SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]!;
    const rec = generateRecord(cat, i, rnd);
    if (total + rec.length > targetBytes && i >= MIN_FIXTURE_RECORDS) break;
    chunks.push(rec);
    expected.push(cat);
    total += rec.length;
    i++;
  }
  const body = chunks.join("");
  return { body, expected, recordCount: expected.length };
}


// ── Calibration copy (P6, local-calibration-design.md section 4.5) ─────

/** Neutral tags shared by every category: the calibration copy's records carry these instead of category hashtags. */
export const NEUTRAL_TAGS = ["#notes", "#misc", "#draft", "#wip", "#review", "#internal", "#v2", "#archive"] as const;

/**
 * The scout fixture as calibration uses it (spec 4.5, F7, A6): the same records, but the per-record categories are a
 * seeded permutation of a balanced list (so "copy the label cycle of the first records" scores near chance, not 100 %
 * as on the production fixture's i % 10 order), and every record's tags are neutral (so the label cannot be copied
 * from a hashtag). `seed` is the permutation seed the record stores. The production fixture and its accuracy ledger
 * are untouched. Sized like generateFixture: about `targetBytes`, never fewer than MIN_FIXTURE_RECORDS records.
 */
export function calibrationScoutFixture(seed: number, targetBytes: number): ScoutFixture {
  const count = Math.max(MIN_FIXTURE_RECORDS, Math.floor(targetBytes / (MIN_FIXTURE_BYTES / MIN_FIXTURE_RECORDS)));
  const rnd = mulberry32(seed);
  const cats: ScoutCategory[] = Array.from({ length: count }, (_, i) => SCOUT_CATEGORIES[i % SCOUT_CATEGORIES.length]!);
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [cats[i], cats[j]] = [cats[j]!, cats[i]!];
  }
  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const tags = Array.from({ length: 2 + (i % 2) }, () => NEUTRAL_TAGS[Math.floor(rnd() * NEUTRAL_TAGS.length)]!).join(" ");
    chunks.push(generateRecord(cats[i]!, i, rnd, tags));
  }
  return { body: chunks.join(""), expected: cats, recordCount: count };
}

// ── Hand-crafted positional JSON Schema ────────────────────────────────

/**
 * minItems/maxItems both = expectedCount to force exact length — the
 * calibration run showed providers hallucinate extra entries when length is
 * unbounded. strict: true + additionalProperties: false, one string per
 * record, in input order.
 */
export function buildPositionalSchema(expectedCount: number): unknown {
  return {
    name: "skill_frontmatter_extraction",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["categories"],
      properties: {
        categories: {
          type: "array",
          minItems: expectedCount,
          maxItems: expectedCount,
          items: {
            type: "string",
            enum: [...SCOUT_CATEGORIES],
          },
          description: `Exactly ${expectedCount} category labels — one per skill-file record, in input order (categories[i] is the category of the record whose name is "skill-${"i".padStart(6, "0")}" for index i).`,
        },
      },
    },
  };
}

// ── Text path: the categories object written as plain text (P6) ───────

/**
 * The `categories` of a reply written as text, not under json_schema (P6, spec 4.5; P8 and P9 reuse it): a think
 * block is dropped (also an unterminated one's opening part), code fences are tolerated, and the JSON object is taken
 * from the first "{" to the last "}"; a bare JSON array is accepted too. Labels are trimmed and lowercased; a
 * non-string entry is an error, not skipped, because positions after it would shift.
 */
export function parsePositionalText(content: string): { categories: string[] } | { error: string } {
  let text = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = text.lastIndexOf("</think>");
  if (open >= 0) text = text.slice(open + "</think>".length);
  text = text.replace(/```(?:json)?/gi, "").trim();
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  let value = tryParse(text);
  if (value === undefined) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) value = tryParse(text.slice(a, b + 1));
  }
  if (value === undefined) {
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a >= 0 && b > a) value = tryParse(text.slice(a, b + 1));
  }
  if (value === undefined) return { error: `no JSON object or array in the reply text: ${JSON.stringify(text.slice(0, 120))}` };
  const list = Array.isArray(value) ? value : typeof value === "object" && value !== null ? (value as { categories?: unknown }).categories : undefined;
  if (!Array.isArray(list)) return { error: "the reply text has no categories array" };
  if (!list.every((v) => typeof v === "string")) return { error: "the categories array holds a non-string entry" };
  return { categories: (list as string[]).map((v) => v.trim().toLowerCase()) };
}
// ── Direct-POST classifier (NO fieldset repair — positional semantics) ──

/**
 * The error prefixes classifyPositional writes (review of a3862052, MINOR-4). Calibration Phase C tells a deadline and
 * a lost connection apart from a real model error by them, so the producer and the reader share these constants.
 */
export const SCOUT_TIMEOUT_PREFIX = "timeout after ";
export const SCOUT_NETWORK_PREFIX = "network: ";
export const SCOUT_HTTP_PREFIX = "HTTP ";
export interface ClassifyPositionalResult {
  predicted: string[];
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  error: string | null;
}

/**
 * One classifyPositional call: POST the fixture to `<baseUrl>/v1/chat/completions`
 * with the hand-crafted schema and return the predicted per-record categories.
 * `opts.fetchImpl` is the test seam (A9a) — never mock module internals in
 * tests; feed fixtures through this. `schema` is the hand-crafted positional
 * schema (buildPositionalSchema).
 */
export async function classifyPositional(
  modelId: string,
  baseUrl: string,
  apiKey: string,
  fixture: ScoutFixture,
  schema: unknown,
  opts: {
    fetchImpl?: FetchImpl;
    timeoutMs?: number;
    /**
     * "json_schema" (default): the schema goes in response_format. "text" (P6, spec 4.5): for a server where a
     * 40-item json_schema array does not work, the schema goes in the prompt and the reply text is parsed
     * (parsePositionalText). P8 and P9 reuse it.
     */
    responseMode?: "json_schema" | "text";
    /** Merged into the request body (a local server's chat_template_kwargs, for example). */
    extraBody?: Record<string, unknown>;
    maxTokens?: number;
  } = {},
): Promise<ClassifyPositionalResult> {
  const doFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const mode = opts.responseMode ?? "json_schema";
  const systemPrompt = [
    "You are a skill-file frontmatter classifier.",
    `Each record of the input is one skill-file block, whose frontmatter carries "name: skill-NNNNNN" where NNNNNN is its index (starting at 0).`,
    `Allowed categories: ${SCOUT_CATEGORIES.join(", ")}.`,
    `For EVERY record, return ONE category. Output a JSON object {"categories": [...]} where categories[i] is the category of the record named "skill-" + i padded to 6 digits.`,
    `The "categories" array MUST have exactly ${fixture.recordCount} entries — one per record.`,
    ...(mode === "text"
      ? [`Reply with only that JSON object, no other text. It must match this JSON Schema: ${JSON.stringify((schema as { schema?: unknown }).schema ?? schema)}`]
      : []),
  ].join(" ");
  const userPrompt = `Classify the following ${fixture.recordCount} skill-file records:\n\n${fixture.body}`;

  const startMs = Date.now();
  const PER_CALL_MS = opts.timeoutMs ?? 90_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_CALL_MS);
  let res: Awaited<ReturnType<FetchImpl>>;
  try {
    res = await doFetch(`${baseUrl}${CHAT_COMPLETIONS_SUFFIX}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // The text path (P6) sends no response_format: the schema is in the system prompt instead.
        ...(mode === "json_schema" ? { response_format: { type: "json_schema", json_schema: schema } } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        temperature: 0.1,
        ...opts.extraBody,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const err = e as Error & { cause?: { code?: unknown } };
    // Node's fetch reports a reset socket as "fetch failed" with the code on its cause: the code is kept in the text.
    const code = typeof err.cause?.code === "string" ? ` (${err.cause.code})` : "";
    return {
      predicted: [],
      promptTokens: 0,
      completionTokens: 0,
      durationMs: Date.now() - startMs,
      error:
        err.name === "AbortError"
          ? `${SCOUT_TIMEOUT_PREFIX}${PER_CALL_MS}ms`
          : `${SCOUT_NETWORK_PREFIX}${err.message}${code}`,
    };
  }
  clearTimeout(timeoutId);
  const durationMs = Date.now() - startMs;
  if (!res.ok) {
    const text = (await res.text().catch(() => "")) ?? "";
    return {
      predicted: [],
      promptTokens: 0,
      completionTokens: 0,
      durationMs,
      error: `${SCOUT_HTTP_PREFIX}${res.status}: ${text.slice(0, 200)}`,
    };
  }
  let payload: {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = (await res.json()) as typeof payload;
  } catch (e) {
    return {
      predicted: [],
      promptTokens: 0,
      completionTokens: 0,
      durationMs,
      error: `non-JSON response: ${(e as Error).message}`,
    };
  }
  const content = payload.choices?.[0]?.message?.content;
  const inTok = payload.usage?.prompt_tokens ?? 0;
  const outTok = payload.usage?.completion_tokens ?? 0;
  if (typeof content !== "string") {
    return {
      predicted: [],
      promptTokens: inTok,
      completionTokens: outTok,
      durationMs,
      error: "no message.content in response",
    };
  }
  let parsed: { categories?: unknown };
  if (mode === "text") {
    // P6 (spec 4.5): without json_schema the model writes the object as text; parsePositionalText finds it.
    const t = parsePositionalText(content);
    if ("error" in t) {
      return { predicted: [], promptTokens: inTok, completionTokens: outTok, durationMs, error: t.error };
    }
    parsed = { categories: t.categories };
  } else {
    try {
      parsed = JSON.parse(content) as typeof parsed;
    } catch (e) {
      return {
        predicted: [],
        promptTokens: inTok,
        completionTokens: outTok,
        durationMs,
        error: `JSON.parse: ${(e as Error).message}`,
      };
    }
  }
  if (!Array.isArray(parsed.categories)) {
    return {
      predicted: [],
      promptTokens: inTok,
      completionTokens: outTok,
      durationMs,
      error: "response.categories not an array",
    };
  }
  // Filter to strings only (the schema's strict: true should make this
  // unnecessary, but defensive).
  const predicted = parsed.categories.filter(
    (v): v is string => typeof v === "string",
  );
  return {
    predicted,
    promptTokens: inTok,
    completionTokens: outTok,
    durationMs,
    error: null,
  };
}

// ── Accuracy scorer ────────────────────────────────────────────────────

export interface ScoutAccuracyScore {
  /** Positions where predicted[i] === expected[i]. */
  correct: number;
  /** Denominator — the fixture's record count. */
  total: number;
  /** correct / total, 0..1 (0 when total is 0). */
  accuracy: number;
}

/** Positional comparison: accuracy = correctly-classified records / total
 *  records. Extra predicted entries beyond expected.length are ignored (the
 *  schema bounds them, but defensive), missing entries simply score as wrong. */
export function scoreAccuracy(
  expected: readonly string[],
  actual: readonly string[],
): ScoutAccuracyScore {
  const total = expected.length;
  const minLen = Math.min(actual.length, total);
  let correct = 0;
  for (let i = 0; i < minLen; i++) {
    if (actual[i] === expected[i]) correct++;
  }
  return { correct, total, accuracy: total === 0 ? 0 : correct / total };
}
