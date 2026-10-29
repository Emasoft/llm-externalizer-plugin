/**
 * calibration/phase-b-fixtures.ts — the pure half of Phase B, "safe input
 * size" (P6; design/specs/local-calibration-design.md section 4.3): the seeded
 * documents, the scorers, the sequential pass rule and the grid. Unit-tested
 * with degenerate answerers in phase-b.test.ts (spec 9); the phase itself
 * (phase-b.ts) only sends what these build and records what they score.
 */

import { BUG_CORPUS } from "./bug-corpus.js";
import { BUG_PLANTS, plantLines } from "./bug-plants.js";
import { normalise, prng, stripThinking, type Outcome, type Reply } from "./phase-a.js";

// ── Seeds and names ─────────────────────────────────────────────────────

/** A stable 32-bit seed from parts (FNV-1a), so a trial's input is rebuilt from its step and index alone. */
export function seedOf(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join("\u0000")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

/** A seeded shuffle (Fisher-Yates). */
export function shuffled<T>(xs: readonly T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}


/**
 * The seed of trial `index`, or of its rerun number `variant` (spec section 2:
 * an inconclusive trial is rerun once). Calibration decodes at temperature 0,
 * so rerunning the same input would only repeat the same cut reply; a rerun
 * gets a new document of the same kind and size instead.
 */
export function variantSeed(stepSeed: number, index: number, variant: number): number {
  return variant === 0 ? seedOf(stepSeed, index) : seedOf(stepSeed, index, "rerun", variant);
}

const SYLLABLES = "har low bren dle cor vin mar ston el wick ash ford tam rin bel mont dor sey fen wald kes tor lun bry gal mere pol den rus kin".split(" ");

/** `n` distinct capitalised names, none in `avoid`. */
function names(r: () => number, n: number, avoid: ReadonlySet<string> = new Set()): string[] {
  const out = new Set<string>();
  while (out.size < n) {
    const w = pick(r, SYLLABLES) + pick(r, SYLLABLES);
    const name = w[0].toUpperCase() + w.slice(1);
    if (!avoid.has(name)) out.add(name);
  }
  return [...out];
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** An 8-character access code (no 0/O/1/I, so a code is never read as another). */
function code(r: () => number): string {
  return Array.from({ length: 8 }, () => CODE_CHARS[Math.floor(r() * CODE_CHARS.length)]).join("");
}

// ── Fact and aggregate documents ────────────────────────────────────────

const THINGS = ["storage key", "delivery window", "maintenance log", "shipping label", "night shift", "inventory count", "alarm panel", "loading bay", "spare badge", "fuel report"];
const PLACES = ["depot", "archive", "warehouse", "office", "station", "workshop", "hangar", "terminal", "garage", "library"];
const DETAILS = [
  "kept in the east wing",
  "checked every Monday",
  "stored on the second floor",
  "renewed each spring",
  "handled by the morning crew",
  "listed in the blue ledger",
  "reviewed after each delivery",
  "posted beside the main door",
  "signed by the site manager",
  "moved to the north corridor",
];

/** One filler sentence in the needles' own style, so a needle does not stand out as the only fluent line (spec 4.3). */
function fillerSentence(r: () => number, places: readonly string[]): string {
  return `The ${pick(r, THINGS)} for ${pick(r, PLACES)} ${pick(r, places)} is ${pick(r, DETAILS)}.`;
}

export const needleSentence = (vault: string, c: string): string => `The access code for vault ${vault} is ${c}.`;

/** Filler of about `chars` characters with `planted` sentences inserted at relative positions (0..1). */
function proseWith(r: () => number, chars: number, fillerNames: readonly string[], planted: ReadonlyArray<{ at: number; text: string }>): string {
  const sentences: string[] = [];
  // The planted sentences count towards the size.
  let n = planted.reduce((s, p) => s + p.text.length + 1, 0);
  while (n < chars) {
    const s = fillerSentence(r, fillerNames);
    sentences.push(s);
    n += s.length + 1;
  }
  // Insert from the back, so earlier indices stay valid.
  const order = [...planted].sort((a, b) => b.at - a.at);
  for (const p of order) sentences.splice(Math.round(p.at * sentences.length), 0, p.text);
  return sentences.join(" ");
}

export interface FactDoc {
  text: string;
  /** The 5 asked vaults, at 5 %, 25 %, 50 %, 75 % and 95 %, in that order. */
  needles: Array<{ vault: string; code: string; at: number }>;
  /** 3 vaults with codes that are never asked about (spec 4.3). */
  decoys: Array<{ vault: string; code: string }>;
}

export const NEEDLE_POSITIONS = [0.05, 0.25, 0.5, 0.75, 0.95] as const;

/** The multi-needle fact document of `seed`, about `chars` characters long. */
export function factDocument(seed: number, chars: number): FactDoc {
  const r = prng(seed);
  const vaults = names(r, 8);
  const fillerNames = names(r, 12, new Set(vaults));
  const needles = NEEDLE_POSITIONS.map((at, i) => ({ vault: vaults[i], code: code(r), at }));
  const decoys = vaults.slice(5).map((vault) => ({ vault, code: code(r) }));
  const planted = [...needles.map((x) => ({ at: x.at, text: needleSentence(x.vault, x.code) })), ...decoys.map((d) => ({ at: 0.1 + r() * 0.8, text: needleSentence(d.vault, d.code) }))];
  return { text: proseWith(r, chars, fillerNames, planted), needles, decoys };
}

export const factQuestion = (vault: string): string => `What is the access code for vault ${vault}? Reply with the code only.`;

export interface AggregateDoc {
  text: string;
  vaults: string[];
}

/**
 * The aggregate document of trial `index` (spec 4.3, A1): 3 to 9 vaults and no
 * decoys. The count walks through 3..9 in a seeded order without repeats in
 * any 7 consecutive trials, so an answerer that always says the same number
 * is right at most once in 7 count trials.
 */
export function aggregateDocument(stepSeed: number, index: number, chars: number, variant = 0): AggregateDoc {
  const counts = shuffled([3, 4, 5, 6, 7, 8, 9], prng(stepSeed));
  const n = counts[index % counts.length];
  const r = prng(variantSeed(stepSeed, index, variant));
  const vaults = names(r, n);
  const fillerNames = names(r, 12, new Set(vaults));
  const planted = vaults.map((v, i) => ({ at: (i + 0.5) / n, text: needleSentence(v, code(r)) }));
  return { text: proseWith(r, chars, fillerNames, planted), vaults };
}

/** Even trials ask for the count, odd ones for the list (each its own trial on its own document, spec 4.3). */
export const aggregateIsCount = (index: number): boolean => index % 2 === 0;
export const AGGREGATE_COUNT_QUESTION = "How many different vaults does the text name? Reply with the number only.";
export const AGGREGATE_LIST_QUESTION = "List the name of every vault the text names, separated by commas. Reply with the names only.";

// ── Bug documents ───────────────────────────────────────────────────────

export interface BugDoc {
  text: string;
  /** The planted file, and the bug line within it (null for the control twin). */
  path: string;
  line: number | null;
}

/** A file shown with numbered lines (spec 4.3: `  12| code`). */
export function numbered(path: string, lines: readonly string[]): string {
  const w = String(lines.length).length;
  return `=== ${path} ===\n${lines.map((l, i) => `${String(i + 1).padStart(w + 2)}| ${l}`).join("\n")}`;
}

/**
 * The bug document of trial `index` (spec 4.3, F5): corpus files in a seeded
 * order, cut at a line boundary to about `chars` characters, with one planted
 * function at a seeded position, buggy or (the control twin) correct. A bug
 * trial and its control share the seed, so they differ only in that one line.
 */
export function bugDocument(stepSeed: number, index: number, chars: number, buggy: boolean, variant = 0): BugDoc {
  const r = prng(variantSeed(stepSeed, index, variant));
  const plant = BUG_PLANTS[(stepSeed + index) % BUG_PLANTS.length];
  const plantText = numbered(plant.path, plantLines(plant, buggy));
  const files: string[] = [];
  let used = plantText.length;
  for (const f of shuffled(BUG_CORPUS, r)) {
    if (used >= chars) break;
    const all = f.text.replace(/\n$/, "").split("\n");
    let keep = all.length;
    // Cut the last file at a line boundary so the document ends near `chars`.
    while (keep > 1 && used + numbered(f.path, all.slice(0, keep)).length + 2 > chars) keep = Math.floor(keep * 0.9);
    files.push(numbered(f.path, all.slice(0, keep)));
    used += files[files.length - 1].length + 2;
  }
  if (used < chars * 0.97) throw new Error(`the bug corpus holds about ${used} characters; a ${chars}-character document cannot be built`);
  files.splice(Math.floor(r() * (files.length + 1)), 0, plantText);
  return { text: files.join("\n\n"), path: plant.path, line: buggy ? plant.bug.line : null };
}

export const BUG_SCHEMA = {
  type: "object",
  properties: { file: { type: ["string", "null"] }, line: { type: ["integer", "null"] } },
  required: ["file", "line"],
  additionalProperties: false,
} as const;

export const bugQuestion = (inPrompt: boolean): string =>
  "Above are the source files of a TypeScript project; each line starts with its line number. At most one of these files contains a bug: " +
  "one line that makes the code behave wrongly at run time. Find it. Answer with a JSON object " +
  '{"file": "<path>", "line": <line number>} that names the file and the line of the bug, or {"file": null, "line": null} when no file has a bug.' +
  (inPrompt ? " Reply with the JSON object only." : "");

// ── Scorers (spec 4.3; a cut reply is inconclusive, never a fail) ────────

const cut = (r: Reply): boolean => r.timedOut || r.finishReason === "length";

/** Fact (spec 4.3): the asked vault's code appears, and no other vault's code (needles and decoys) does. */
export function factOutcome(r: Reply, expected: string, allCodes: readonly string[]): Outcome {
  if (cut(r)) return "inconclusive";
  if (r.status !== 200) return "fail";
  const answer = stripThinking(r.content).toUpperCase();
  const has = (c: string): boolean => new RegExp(`(^|[^A-Z0-9])${c}([^A-Z0-9]|$)`).test(answer);
  if (!has(expected)) return "fail";
  return allCodes.some((c) => c !== expected && has(c)) ? "fail" : "pass";
}

const NUMBER_WORDS = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");

/** Aggregate count: every number in the answer (digits or a word up to twenty) is the right one, and there is one. */
export function aggregateCountOutcome(r: Reply, n: number): Outcome {
  if (cut(r)) return "inconclusive";
  if (r.status !== 200) return "fail";
  const words: string[] = normalise(stripThinking(r.content)).match(/[a-z0-9]+/g) ?? [];
  const nums = words.flatMap((w) => (/^\d+$/.test(w) ? [Number(w)] : NUMBER_WORDS.includes(w) ? [NUMBER_WORDS.indexOf(w)] : []));
  return nums.length > 0 && nums.every((x) => x === n) ? "pass" : "fail";
}

/** The vault names in a list answer: split on commas, newlines, "and" and bullets; "vault" and punctuation dropped. */
export function listedNames(answer: string): string[] {
  return answer
    .split(/,|;|\n|\band\b/i)
    .map((s) =>
      normalise(
        s
          .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
          .replace(/\bvaults?\b/gi, "")
          .replace(/[^\p{L}\p{N}\s-]/gu, ""),
      ),
    )
    .filter((s) => s !== "");
}

/** Aggregate list: exactly the set of vault names, order ignored, nothing missing and nothing extra. */
export function aggregateListOutcome(r: Reply, vaults: readonly string[]): Outcome {
  if (cut(r)) return "inconclusive";
  if (r.status !== 200) return "fail";
  const got = new Set(listedNames(stripThinking(r.content)));
  const want = new Set(vaults.map((v) => normalise(v)));
  return got.size === want.size && [...want].every((v) => got.has(v)) ? "pass" : "fail";
}

/** The `{file, line}` object of a bug answer: the whole answer as JSON, else its last flat `{...}`; null when there is none. */
export function parseBugAnswer(text: string): { file: string | null; line: number | null } | null {
  const s = stripThinking(text).replace(/^```(?:json)?\s*|\s*```$/g, "");
  const tryParse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let v = tryParse(s);
  if (v === undefined) {
    const all = s.match(/\{[^{}]*\}/g);
    v = all ? tryParse(all[all.length - 1]) : undefined;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const file = o.file === null ? null : typeof o.file === "string" ? o.file : undefined;
  const line = o.line === null ? null : typeof o.line === "number" && Number.isInteger(o.line) ? o.line : typeof o.line === "string" && /^\d+$/.test(o.line.trim()) ? Number(o.line) : undefined;
  if (file === undefined || line === undefined) return null;
  return { file, line };
}

const samePath = (a: string, b: string): boolean => {
  const n = (p: string): string => p.trim().replace(/^`|`$/g, "").replace(/^\.?\//, "");
  return n(a) === n(b);
};

/**
 * Bug (spec 4.3, F5): the right file and a line within 1 of the bug. Control
 * (the correct twin): `{"file": null, "line": null}` exactly.
 */
export function bugOutcome(r: Reply, expected: { path: string; line: number | null }): Outcome {
  if (cut(r)) return "inconclusive";
  if (r.status !== 200) return "fail";
  const a = parseBugAnswer(r.content);
  if (a === null) return "fail";
  if (expected.line === null) return a.file === null && a.line === null ? "pass" : "fail";
  return a.file !== null && a.line !== null && samePath(a.file, expected.path) && Math.abs(a.line - expected.line) <= 1 ? "pass" : "fail";
}

// ── The sequential pass rule and the grid ───────────────────────────────

/**
 * The sequential rule of one counter (spec 4.3, F6, A2), for `t` trials per
 * round (5 in production): t of t passes; 0.4 t or fewer fails; anything
 * between adds t more trials and passes at 0.8 x 2t or better. A verdict
 * already certain is returned early ("more" = run another trial). Only
 * conclusive outcomes are given; inconclusive trials never count.
 */
export function sequentialVerdict(outcomes: readonly Outcome[], t: number): "pass" | "fail" | "more" {
  const n = outcomes.length;
  const passed = outcomes.filter((o) => o === "pass").length;
  const failLine = Math.floor(0.4 * t);
  const need2 = Math.ceil(1.6 * t);
  if (n < t) return passed + (t - n) <= failLine ? "fail" : "more";
  if (n === t) {
    if (passed === t) return "pass";
    return passed <= failLine ? "fail" : "more";
  }
  if (passed >= need2) return "pass";
  if (passed + (2 * t - n) < need2) return "fail";
  return n >= 2 * t ? "fail" : "more";
}

/**
 * The grid steps, largest first (spec 4.3, F3, N9): 2048, 4096, 8192 and
 * 0.40 x W, none above 0.40 x W. A reduced harness gives its own steps, used
 * as given (spec 9: steps 2048 and 4096 at W 4096).
 */
export function gridSteps(window: number, harnessSteps: readonly number[] | null): number[] {
  if (harnessSteps !== null) return [...new Set(harnessSteps)].sort((a, b) => b - a);
  const top = Math.floor(0.4 * window);
  return [...new Set([2048, 4096, 8192, top].filter((s) => s <= top))].sort((a, b) => b - a);
}

/** Output floor of a kind (spec 4.3, F15, N4): the largest passing, non-truncated completion x 1.25, rounded up to 256; 0 when none. */
export function outputFloor(completions: readonly number[]): number {
  if (completions.length === 0) return 0;
  return Math.ceil((Math.max(...completions) * 1.25) / 256) * 256;
}
