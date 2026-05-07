/**
 * Calibration: per-tweet classification accuracy vs payload size.
 *
 * Generates a synthetic file at each target size, packed with tweets where
 * tweet `i` is dominated by category `CATEGORIES[i % N]`. Asks the model to
 * return ONE category per tweet, in input order (positional array). Reports
 * per-size accuracy = correctly-classified-tweets / total-tweets.
 *
 * IMPORTANT: this test does NOT use the scout pipeline. The fieldset DSL's
 * `array_enum` field repairs/dedups the response, which would collapse
 * adjacent same-category outputs and corrupt positional semantics. Instead,
 * we hand-craft the JSON Schema and POST it directly to OpenRouter.
 *
 * Sweep range: per the user's instruction, files above 50% of the model's
 * context window aren't tested (registration would refuse them anyway).
 * For qwen-2.5-7b-instruct (128K tokens × 4 bytes/token = 512KB context),
 * 50% = 256KB; the largest test size is 250KB.
 *
 * GATED: only runs when BOTH `CALIBRATE=1` AND `OPENROUTER_API_KEY` are
 * set. Default `npm test` reports the suite as skipped (~0ms).
 *
 *   CALIBRATE=1 OPENROUTER_API_KEY=$KEY \
 *     npx vitest run src/mass_scouting/calibrate-payload-size.test.ts
 *
 * Output: a markdown report under
 *   `<main-repo-root>/reports/mass_scouting_calibration/<TIMESTAMP>-calibration.md`
 *
 * Cost ceiling: 11 sizes × ~$0.005 worst case ≈ $0.06 per run.
 */

import { afterAll, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_PRICING,
  bytesCapFromPct,
  type ModelPricing,
} from "./cost-estimate";

// ── Gating ─────────────────────────────────────────────────────────────

const CALIBRATE_ENABLED =
  process.env.CALIBRATE === "1" && !!process.env.OPENROUTER_API_KEY;

const skipReason = !CALIBRATE_ENABLED
  ? "[skipped] set CALIBRATE=1 and export OPENROUTER_API_KEY to run"
  : "";

// ── Configuration ──────────────────────────────────────────────────────

const MODEL = "qwen/qwen-2.5-7b-instruct";
const PRICING: ModelPricing = KNOWN_PRICING[MODEL]!;
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Size sweep: 10KB → 250KB. 250KB ≈ 49% of qwen-2.5-7b's 128K token
 * context (at 4 bytes/token). Tighter resolution near the ceiling.
 */
const SIZES_BYTES = [
  10_000,
  25_000,
  50_000,
  75_000,
  100_000,
  125_000,
  150_000,
  175_000,
  200_000,
  225_000,
  250_000,
];

const CATEGORIES = [
  "sport",
  "cinema",
  "software",
  "politics",
  "war",
  "music",
  "food",
  "humor",
  "psychology",
  "business",
] as const;
type Category = (typeof CATEGORIES)[number];

interface CategoryVocab {
  /** ~30 distinctive words; shorter list = higher per-tweet density. */
  words: string[];
  /** Hashtags appended to every tweet — strong signal for the classifier. */
  tags: string[];
}

const VOCAB: Record<Category, CategoryVocab> = {
  sport: {
    words: [
      "championship", "match", "goal", "score", "league", "playoffs",
      "tournament", "basketball", "football", "soccer", "tennis", "NBA",
      "NFL", "MLB", "ref", "victory", "training", "stadium", "olympic",
      "athletes", "coach", "transfer", "kickoff", "halftime", "rebound",
      "touchdown", "sprint", "marathon", "knockout", "rookie",
    ],
    tags: ["#sports", "#NBA", "#football", "#championship"],
  },
  cinema: {
    words: [
      "movie", "film", "actor", "director", "oscar", "screenplay",
      "blockbuster", "sequel", "premiere", "Hollywood", "trailer",
      "cinematography", "boxoffice", "rating", "soundtrack", "drama",
      "thriller", "comedy-film", "documentary", "actress", "cinematic",
      "cast", "scene", "plot", "twist", "release", "starring", "Marvel",
      "festival", "review",
    ],
    tags: ["#cinema", "#movies", "#film", "#oscar"],
  },
  software: {
    words: [
      "code", "commit", "deploy", "refactor", "API", "framework", "repo",
      "kernel", "async", "debug", "JavaScript", "Python", "TypeScript",
      "compiler", "runtime", "container", "Docker", "Kubernetes", "merge",
      "PR", "linter", "build", "CI", "release", "library", "module",
      "package", "regression", "endpoint", "GraphQL",
    ],
    tags: ["#programming", "#dev", "#opensource", "#code"],
  },
  politics: {
    words: [
      "election", "vote", "senator", "parliament", "minister", "treaty",
      "president", "congress", "party", "Democrat", "Republican", "ballot",
      "campaign", "policy", "diplomat", "embassy", "lobbying", "filibuster",
      "primary", "caucus", "constitution", "amendment", "rally",
      "incumbent", "opposition", "coalition", "referendum", "summit",
      "press-secretary", "governance",
    ],
    tags: ["#politics", "#election", "#government", "#congress"],
  },
  war: {
    words: [
      "troops", "battle", "military", "ceasefire", "frontline", "ammunition",
      "sanction", "warzone", "soldier", "army", "tank", "drone", "missile",
      "airstrike", "convoy", "battalion", "general", "fleet", "siege",
      "occupation", "evacuation", "hostage", "casualty", "barracks",
      "skirmish", "infantry", "reinforcement", "war-crime", "genocide",
      "ammo",
    ],
    tags: ["#war", "#military", "#conflict", "#defense"],
  },
  music: {
    words: [
      "album", "concert", "guitar", "melody", "vinyl", "EP", "festival",
      "headliner", "songwriter", "Billboard", "tour", "stage", "track",
      "single", "remix", "synthesizer", "harmony", "drums", "violin",
      "rapper", "singer", "vocalist", "soundcheck", "lyrics", "beat",
      "studio", "record-label", "producer", "Coachella", "Grammys",
    ],
    tags: ["#music", "#concert", "#newalbum", "#tour"],
  },
  food: {
    words: [
      "recipe", "cuisine", "ingredient", "restaurant", "chef", "dish",
      "Michelin", "flavor", "kitchen", "pasta", "sushi", "vegan", "spice",
      "marinade", "sauce", "broth", "bake", "grill", "saute", "dessert",
      "patisserie", "olive-oil", "tasting", "tableware", "cutlery",
      "wine-pairing", "appetizer", "entree", "ramen", "soufflé",
    ],
    tags: ["#food", "#foodie", "#chef", "#recipe"],
  },
  humor: {
    words: [
      "joke", "punchline", "hilarious", "sarcasm", "pun", "satire", "meme",
      "lol", "prank", "comedian", "witty", "irony", "parody", "gag",
      "stand-up", "sketch", "rofl", "roast", "deadpan", "absurd", "slapstick",
      "knock-knock", "improv", "amused", "ridiculous", "facepalm", "snort",
      "tongue-in-cheek", "comic-relief", "wisecrack",
    ],
    tags: ["#humor", "#funny", "#meme", "#lol"],
  },
  psychology: {
    words: [
      "cognitive", "anxiety", "depression", "therapy", "mindfulness",
      "behavior", "emotion", "neuropsychology", "schema", "psyche", "ego",
      "Freud", "bipolar", "trauma", "motivation", "introvert", "extrovert",
      "perception", "self-esteem", "PTSD", "psychotherapy", "neurosis",
      "Jungian", "subconscious", "burnout", "OCD", "psychiatry",
      "narcissism", "empathy", "psyche-evaluation",
    ],
    tags: ["#psychology", "#mentalhealth", "#therapy", "#mindfulness"],
  },
  business: {
    words: [
      "startup", "IPO", "revenue", "CEO", "market-cap", "acquisition",
      "merger", "equity", "VC", "founder", "runway", "pivot", "MVP",
      "B2B", "SaaS", "valuation", "fundraising", "ARR", "burn-rate",
      "investor", "stakeholder", "term-sheet", "due-diligence", "EBITDA",
      "P&L", "balance-sheet", "ROI", "payroll", "scaling", "TAM",
    ],
    tags: ["#business", "#startup", "#entrepreneur", "#VC"],
  },
};

// ── Synthetic-tweet generation ─────────────────────────────────────────

/**
 * Build one tweet keyed by `(category, idx)`. Deterministic. Each tweet
 * starts with `Tweet N:` so the model can see which slot it is filling
 * (and we can audit predicted vs expected positionally).
 */
function generateTweet(category: Category, tweetIdx: number): string {
  const v = VOCAB[category];
  const wordCount = 5 + (tweetIdx % 3); // 5..7 words
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    words.push(v.words[(tweetIdx + i * 7) % v.words.length]!);
  }
  const tags = v.tags.slice(0, 2 + (tweetIdx % 2)).join(" "); // 2..3 tags
  return `Tweet ${tweetIdx}: ${words.join(" ")} -- ${tags}\n`;
}

/**
 * Generate a stream of tweets where tweet i has category `expected[i]`.
 * Returns the file body string AND the expected category sequence used
 * (the array of length M = number of complete tweets that fit).
 */
function generateFile(
  targetBytes: number,
): { body: string; expected: Category[] } {
  const chunks: string[] = [];
  const expected: Category[] = [];
  let total = 0;
  let i = 0;
  while (total < targetBytes) {
    const cat = CATEGORIES[i % CATEGORIES.length]!;
    const t = generateTweet(cat, i);
    if (total + t.length > targetBytes && expected.length > 0) break;
    chunks.push(t);
    expected.push(cat);
    total += t.length;
    i++;
  }
  return { body: chunks.join(""), expected };
}

// ── OpenRouter call (manual — bypasses the scout pipeline) ─────────────

interface ClassifyResult {
  predicted: string[];
  cost_usd: number;
  duration_ms: number;
  error: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  raw_truncated: string | null;
}

async function classifyTweets(
  apiKey: string,
  fileBody: string,
  expectedCount: number,
): Promise<ClassifyResult> {
  // Hand-crafted JSON Schema. minItems/maxItems both = expectedCount to
  // force exact length — the first run showed providers will hallucinate
  // way more entries than expected when length is unbounded.
  const schema = {
    name: "tweet_classification",
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
            enum: [...CATEGORIES],
          },
          description: `Exactly ${expectedCount} category labels — one per tweet, in input order (categories[i] is the category of the line "Tweet i:").`,
        },
      },
    },
  };

  const systemPrompt = [
    "You are a tweet topic classifier.",
    `Each line of the input is one tweet, prefixed with "Tweet N:" where N is its index (starting at 0).`,
    `Allowed categories: ${CATEGORIES.join(", ")}.`,
    `For EVERY tweet, return ONE category. Output a JSON object {"categories": [...]} where categories[i] is the category of "Tweet i:".`,
    `The "categories" array MUST have exactly ${expectedCount} entries — one per tweet.`,
  ].join(" ");

  const userPrompt = `Classify the following ${expectedCount} tweets:\n\n${fileBody}`;

  const startMs = Date.now();
  // Per-call timeout — fetch in Node has no default. The first run showed
  // some providers can hang indefinitely on big inputs; a hard ceiling
  // surfaces those as "timeout" rather than killing the whole sweep.
  const PER_CALL_MS = 90_000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_CALL_MS);
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: schema },
        temperature: 0.1,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const err = e as Error;
    return {
      predicted: [],
      cost_usd: 0,
      duration_ms: Date.now() - startMs,
      error:
        err.name === "AbortError"
          ? `timeout after ${PER_CALL_MS}ms`
          : `network: ${err.message}`,
      prompt_tokens: 0,
      completion_tokens: 0,
      raw_truncated: null,
    };
  }
  clearTimeout(timeoutId);
  const duration_ms = Date.now() - startMs;
  if (!res.ok) {
    const text = (await res.text().catch(() => "")) ?? "";
    return {
      predicted: [],
      cost_usd: 0,
      duration_ms,
      error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
      prompt_tokens: 0,
      completion_tokens: 0,
      raw_truncated: null,
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
      cost_usd: 0,
      duration_ms,
      error: `non-JSON response: ${(e as Error).message}`,
      prompt_tokens: 0,
      completion_tokens: 0,
      raw_truncated: null,
    };
  }
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return {
      predicted: [],
      cost_usd: 0,
      duration_ms,
      error: "no message.content in response",
      prompt_tokens: payload.usage?.prompt_tokens ?? 0,
      completion_tokens: payload.usage?.completion_tokens ?? 0,
      raw_truncated: null,
    };
  }
  const inTok = payload.usage?.prompt_tokens ?? 0;
  const outTok = payload.usage?.completion_tokens ?? 0;
  const cost =
    (inTok / 1_000_000) * PRICING.input_per_m_usd +
    (outTok / 1_000_000) * PRICING.output_per_m_usd;

  let parsed: { categories?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch (e) {
    return {
      predicted: [],
      cost_usd: cost,
      duration_ms,
      error: `JSON.parse: ${(e as Error).message}`,
      prompt_tokens: inTok,
      completion_tokens: outTok,
      raw_truncated: content.slice(0, 200),
    };
  }
  if (!Array.isArray(parsed.categories)) {
    return {
      predicted: [],
      cost_usd: cost,
      duration_ms,
      error: "response.categories not an array",
      prompt_tokens: inTok,
      completion_tokens: outTok,
      raw_truncated: content.slice(0, 200),
    };
  }
  // Filter to strings only (the schema's `strict: true` should make this
  // unnecessary, but defensive).
  const predicted = parsed.categories.filter(
    (v): v is string => typeof v === "string",
  );
  return {
    predicted,
    cost_usd: cost,
    duration_ms,
    error: null,
    prompt_tokens: inTok,
    completion_tokens: outTok,
    raw_truncated: null,
  };
}

// ── Report output ──────────────────────────────────────────────────────

function resolveMainRoot(): string {
  try {
    const out = execSync("git worktree list", { encoding: "utf-8" })
      .split("\n")[0]
      ?.trim()
      .split(/\s+/)[0];
    if (out) return out;
  } catch {
    // git not available — fall through.
  }
  // Fallback: walk up from this file's directory.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

interface CalibRow {
  size_bytes: number;
  size_label: string;
  tweets_in_file: number;
  predicted_count: number;
  correct_count: number;
  accuracy_pct: number;
  duration_ms: number;
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  error: string | null;
  raw_truncated: string | null;
}

const rows: CalibRow[] = [];

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)}KB`;
  return `${bytes}B`;
}

afterAll(() => {
  if (!CALIBRATE_ENABLED) return;
  if (rows.length === 0) return;
  const mainRoot = resolveMainRoot();
  const reportDir = join(mainRoot, "reports", "mass_scouting_calibration");
  mkdirSync(reportDir, { recursive: true });
  // Local timestamp + GMT offset, per agent-reports-location rule.
  const now = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const tzMin = -now.getTimezoneOffset(); // minutes east of UTC
  const tzSign = tzMin >= 0 ? "+" : "-";
  const tzAbs = Math.abs(tzMin);
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `${tzSign}${pad(Math.floor(tzAbs / 60))}${pad(tzAbs % 60)}`;
  const path = join(reportDir, `${stamp}-tweet-classification.md`);
  writeFileSync(path, renderReport(rows), "utf-8");
  console.log(`[calibration] report written: ${path}`);
});

function renderReport(rs: CalibRow[]): string {
  const lines: string[] = [];
  const ctxBytes = PRICING.context_window * 4;
  lines.push("# Mass-scouting payload-size calibration (per-tweet)");
  lines.push("");
  lines.push(`- **Model:** \`${MODEL}\``);
  lines.push(
    `- **Context window:** ${PRICING.context_window} tokens (≈ ${formatSize(ctxBytes)} at 4 bytes/token)`,
  );
  lines.push(
    `- **Register cap (50%):** ${formatSize(bytesCapFromPct(PRICING.context_window, 0.5))}`,
  );
  lines.push(
    `- **Scout cap (40%):** ${formatSize(bytesCapFromPct(PRICING.context_window, 0.4))}`,
  );
  lines.push(`- **Categories:** ${CATEGORIES.join(", ")} (${CATEGORIES.length} total)`);
  lines.push(`- **Run date:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("Each file is a stream of tweets where tweet `i` has category `CATEGORIES[i % 10]`.");
  lines.push("The model is asked to return a per-tweet category array. Accuracy = correct positions / total tweets.");
  lines.push("");
  lines.push("## Results");
  lines.push("");
  lines.push("| Size | %ctx | Tweets | Predicted | Correct | Accuracy | Duration | $cost | in tok | out tok | Error |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of rs) {
    const pct = ((r.size_bytes / ctxBytes) * 100).toFixed(0) + "%";
    const accStr =
      r.tweets_in_file === 0 ? "—" : `${r.accuracy_pct.toFixed(1)}%`;
    lines.push(
      `| ${formatSize(r.size_bytes)} | ${pct} | ${r.tweets_in_file} | ${r.predicted_count} | ${r.correct_count} | ${accStr} | ${r.duration_ms}ms | $${r.cost_usd.toFixed(6)} | ${r.prompt_tokens} | ${r.completion_tokens} | ${r.error ?? ""} |`,
    );
  }
  lines.push("");
  // Summary
  const totalCost = rs.reduce((acc, r) => acc + r.cost_usd, 0);
  const totalTime = rs.reduce((acc, r) => acc + r.duration_ms, 0);
  const okRows = rs.filter((r) => r.error === null);
  const lastGoodRow = [...okRows]
    .reverse()
    .find((r) => r.accuracy_pct >= 95);
  const firstDegradedRow = okRows.find((r) => r.accuracy_pct < 95);
  const firstFailedRow = rs.find((r) => r.error !== null);
  lines.push("## Summary");
  lines.push("");
  lines.push(`- **Successful classifications:** ${okRows.length} / ${rs.length}`);
  lines.push(`- **Total cost:** $${totalCost.toFixed(6)}`);
  lines.push(`- **Total wall-clock:** ${(totalTime / 1000).toFixed(1)}s`);
  if (lastGoodRow) {
    lines.push(
      `- **Largest size with ≥95% accuracy:** ${formatSize(lastGoodRow.size_bytes)} (${lastGoodRow.tweets_in_file} tweets, ${lastGoodRow.accuracy_pct.toFixed(1)}% correct)`,
    );
  }
  if (firstDegradedRow) {
    lines.push(
      `- **First size below 95% accuracy:** ${formatSize(firstDegradedRow.size_bytes)} (${firstDegradedRow.accuracy_pct.toFixed(1)}% correct)`,
    );
  }
  if (firstFailedRow) {
    lines.push(
      `- **First failed size:** ${formatSize(firstFailedRow.size_bytes)} → ${firstFailedRow.error}`,
    );
  }
  return lines.join("\n");
}

// ── Test ───────────────────────────────────────────────────────────────

describe.skipIf(!CALIBRATE_ENABLED)(
  `mass-scouting payload-size calibration ${skipReason}`,
  () => {
    it(
      "sweeps file sizes and records per-tweet accuracy",
      async () => {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("OPENROUTER_API_KEY missing — gate bug");

        for (let i = 0; i < SIZES_BYTES.length; i++) {
          const sizeBytes = SIZES_BYTES[i]!;
          const { body, expected } = generateFile(sizeBytes);
          const expectedCount = expected.length;

          const result = await classifyTweets(apiKey, body, expectedCount);

          // Positional comparison up to the shorter of the two arrays.
          const minLen = Math.min(result.predicted.length, expected.length);
          let correct = 0;
          for (let j = 0; j < minLen; j++) {
            if (result.predicted[j] === expected[j]) correct++;
          }
          const accuracy =
            expectedCount === 0 ? 0 : (correct / expectedCount) * 100;

          rows.push({
            size_bytes: sizeBytes,
            size_label: formatSize(sizeBytes),
            tweets_in_file: expectedCount,
            predicted_count: result.predicted.length,
            correct_count: correct,
            accuracy_pct: accuracy,
            duration_ms: result.duration_ms,
            cost_usd: result.cost_usd,
            prompt_tokens: result.prompt_tokens,
            completion_tokens: result.completion_tokens,
            error: result.error,
            raw_truncated: result.raw_truncated,
          });

          // Progress breadcrumb.
          console.log(
            `[${i + 1}/${SIZES_BYTES.length}] ${formatSize(sizeBytes)} ` +
              `tweets=${expectedCount} predicted=${result.predicted.length} ` +
              `correct=${correct} acc=${accuracy.toFixed(1)}% ` +
              `${result.duration_ms}ms $${result.cost_usd.toFixed(6)}` +
              (result.error ? ` err=${result.error.slice(0, 80)}` : ""),
          );
        }

        // Smoke check: every size produced a row, AND at least one of
        // them got > 50% accuracy. That's enough to confirm the test
        // infrastructure is wired (not validating the model itself —
        // the report is the deliverable, accuracy varies run to run).
        expect(rows.length).toBe(SIZES_BYTES.length);
        const okRows = rows.filter((r) => r.error === null);
        expect(okRows.length).toBeGreaterThan(0);
        const anyAbove50 = okRows.some((r) => r.accuracy_pct > 50);
        expect(anyAbove50).toBe(true);
      },
      // 11 sizes × 90s per-call worst case = 990s. Allow 30 min for the
      // whole sweep (extra slack for first-call provider warmup).
      1_800_000,
    );
  },
);
