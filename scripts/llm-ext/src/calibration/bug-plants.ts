/**
 * calibration/bug-plants.ts — the 20 planted functions of the Phase B bug
 * trials (P6; design/specs/local-calibration-design.md section 4.3, F5).
 *
 * Each is a small file in the style of the filler corpus, written correct;
 * `bug` replaces exactly one line with a wrong one (off-by-one, inverted
 * condition, wrong variable, missing await, ...). A bug trial shows the buggy
 * file and expects that file and line (within 1); its control twin shows the
 * correct file and expects no bug at all. The bug line is never the first two
 * or the last two lines of the file, so an answerer that always names the
 * first or the last line cannot pass (spec 9).
 *
 * Changing anything here changes the fixture: bump FIXTURE_VERSION (record.ts).
 */

export interface BugPlant {
  /** The file path shown to the model. */
  path: string;
  /** The correct file, one string per line. */
  code: readonly string[];
  /** The one line (1-based) the bug replaces, and its buggy text. */
  bug: { line: number; text: string };
}

export const BUG_PLANTS: readonly BugPlant[] = [
  {
    path: "src/util/clamp-range.ts",
    code: [
      "/** Clamp `value` into [lo, hi]; the bounds may come in either order. */",
      "export function clampRange(value: number, lo: number, hi: number): number {",
      "  if (lo > hi) [lo, hi] = [hi, lo];",
      "  if (value < lo) return lo;",
      "  if (value > hi) return hi;",
      "  return value;",
      "}",
    ],
    bug: { line: 5, text: "  if (value > hi) return lo;" },
  },
  {
    path: "src/util/chunk-array.ts",
    code: [
      "/** Split `items` into consecutive chunks of at most `size` items. */",
      "export function chunkArray<T>(items: readonly T[], size: number): T[][] {",
      "  if (size < 1) throw new Error(`chunk size must be at least 1, got ${size}`);",
      "  const out: T[][] = [];",
      "  for (let i = 0; i < items.length; i += size) {",
      "    out.push(items.slice(i, i + size));",
      "  }",
      "  return out;",
      "}",
    ],
    bug: { line: 6, text: "    out.push(items.slice(i, i + size - 1));" },
  },
  {
    path: "src/util/last-n.ts",
    code: [
      "/** The last `n` items of a list (all of them when it is shorter). */",
      "export function lastN<T>(items: readonly T[], n: number): T[] {",
      "  if (n <= 0) return [];",
      "  if (n >= items.length) return [...items];",
      "  return items.slice(items.length - n);",
      "}",
      "",
    ],
    bug: { line: 5, text: "  return items.slice(items.length - n - 1);" },
  },
  {
    path: "src/stats/sum-by.ts",
    code: [
      "/** The sum of `pick(item)` over every item. */",
      "export function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {",
      "  let total = 0;",
      "  for (const item of items) {",
      "    const value = pick(item);",
      "    total += value;",
      "  }",
      "  return total;",
      "}",
    ],
    bug: { line: 6, text: "    total = value;" },
  },
  {
    path: "src/net/fetch-all.ts",
    code: [
      "/** Fetch every URL in order and return the parsed JSON bodies. */",
      "export async function fetchAll(urls: readonly string[]): Promise<unknown[]> {",
      "  const bodies: unknown[] = [];",
      "  for (const url of urls) {",
      "    const res = await fetch(url);",
      "    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);",
      "    const body: unknown = await res.json();",
      "    bodies.push(body);",
      "  }",
      "  return bodies;",
      "}",
    ],
    bug: { line: 7, text: "    const body: unknown = res.json();" },
  },
  {
    path: "src/time/leap-year.ts",
    code: [
      "/** Gregorian leap year: divisible by 4, except centuries, except every 400 years. */",
      "export function isLeapYear(year: number): boolean {",
      "  if (year % 400 === 0) return true;",
      "  if (year % 100 === 0) return false;",
      "  return year % 4 === 0;",
      "}",
      "",
    ],
    bug: { line: 4, text: "  if (year % 100 === 0) return true;" },
  },
  {
    path: "src/search/binary-search.ts",
    code: [
      "/** Index of `target` in the ascending array `sorted`, or -1. */",
      "export function binarySearch(sorted: readonly number[], target: number): number {",
      "  let lo = 0;",
      "  let hi = sorted.length - 1;",
      "  while (lo <= hi) {",
      "    const mid = (lo + hi) >> 1;",
      "    if (sorted[mid] === target) return mid;",
      "    if (sorted[mid] < target) lo = mid + 1;",
      "    else hi = mid - 1;",
      "  }",
      "  return -1;",
      "}",
    ],
    bug: { line: 8, text: "    if (sorted[mid] > target) lo = mid + 1;" },
  },
  {
    path: "src/util/dedupe-by-key.ts",
    code: [
      "/** Keep the first item of each key, in their original order. */",
      "export function dedupeByKey<T>(items: readonly T[], key: (item: T) => string): T[] {",
      "  const seen = new Set<string>();",
      "  const out: T[] = [];",
      "  for (const item of items) {",
      "    const k = key(item);",
      "    if (seen.has(k)) continue;",
      "    seen.add(k);",
      "    out.push(item);",
      "  }",
      "  return out;",
      "}",
    ],
    bug: { line: 7, text: "    if (!seen.has(k)) continue;" },
  },
  {
    path: "src/time/parse-duration.ts",
    code: [
      "/** Parse a duration such as `90s`, `5m` or `2h` into milliseconds. */",
      "export function parseDuration(text: string): number {",
      "  const m = /^(\\d+)(ms|s|m|h)$/.exec(text.trim());",
      "  if (!m) throw new Error(`not a duration: '${text}'`);",
      "  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };",
      "  return Number(m[1]) * unit[m[2]];",
      "}",
    ],
    bug: { line: 5, text: "  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 360_000 };" },
  },
  {
    path: "src/net/retry-delay.ts",
    code: [
      "/** Exponential backoff: base x 2^attempt, never above `maxMs`. */",
      "export function retryDelay(attempt: number, baseMs: number, maxMs: number): number {",
      "  if (attempt < 0) throw new Error(`attempt must be 0 or more, got ${attempt}`);",
      "  const delay = baseMs * 2 ** attempt;",
      "  return Math.min(maxMs, delay);",
      "}",
      "",
    ],
    bug: { line: 5, text: "  return Math.max(maxMs, delay);" },
  },
  {
    path: "src/text/count-words.ts",
    code: [
      "/** The number of words in a text (runs of non-space characters). */",
      "export function countWords(text: string): number {",
      "  const words = text.split(/\\s+/);",
      "  const real = words.filter((w) => w.length > 0);",
      "  return real.length;",
      "}",
      "",
    ],
    bug: { line: 4, text: "  const real = words.filter((w) => w.length > 1);" },
  },
  {
    path: "src/util/merge-sorted.ts",
    code: [
      "/** Merge two ascending arrays into one ascending array. */",
      "export function mergeSorted(a: readonly number[], b: readonly number[]): number[] {",
      "  const out: number[] = [];",
      "  let i = 0;",
      "  let j = 0;",
      "  while (i < a.length && j < b.length) {",
      "    if (a[i] <= b[j]) out.push(a[i++]);",
      "    else out.push(b[j++]);",
      "  }",
      "  while (i < a.length) out.push(a[i++]);",
      "  while (j < b.length) out.push(b[j++]);",
      "  return out;",
      "}",
    ],
    bug: { line: 11, text: "  while (j < b.length) out.push(b[i++]);" },
  },
  {
    path: "src/stats/percentile.ts",
    code: [
      "/** The nearest-rank percentile `p` (0 < p <= 100) of a non-empty list. */",
      "export function percentile(values: readonly number[], p: number): number {",
      "  if (values.length === 0) throw new Error(\"percentile of an empty list\");",
      "  const sorted = [...values].sort((x, y) => x - y);",
      "  const rank = Math.ceil((p / 100) * sorted.length);",
      "  return sorted[Math.max(0, rank - 1)];",
      "}",
      "",
    ],
    bug: { line: 6, text: "  return sorted[Math.max(0, rank)];" },
  },
  {
    path: "src/path/trim-trailing-slash.ts",
    code: [
      "/** Remove trailing slashes from a path, keeping a lone root slash. */",
      "export function trimTrailingSlash(path: string): string {",
      "  let s = path;",
      "  while (s.length > 1 && s.endsWith(\"/\")) s = s.slice(0, -1);",
      "  return s;",
      "}",
      "",
    ],
    bug: { line: 4, text: "  while (s.length > 1 && s.endsWith(\"/\")) s = s.slice(1);" },
  },
  {
    path: "src/util/group-by.ts",
    code: [
      "/** Group items by key, keeping their order within each group. */",
      "export function groupBy<T>(items: readonly T[], key: (item: T) => string): Record<string, T[]> {",
      "  const out: Record<string, T[]> = {};",
      "  for (const item of items) {",
      "    const k = key(item);",
      "    (out[k] ??= []).push(item);",
      "  }",
      "  return out;",
      "}",
    ],
    bug: { line: 6, text: "    out[k] = [item];" },
  },
  {
    path: "src/cache/is-expired.ts",
    code: [
      "export interface CacheEntry {",
      "  createdAt: number;",
      "  ttlMs: number;",
      "}",
      "",
      "/** An entry is expired once its time to live has passed. */",
      "export function isExpired(entry: CacheEntry, now: number): boolean {",
      "  const age = now - entry.createdAt;",
      "  return age > entry.ttlMs;",
      "}",
      "",
    ],
    bug: { line: 9, text: "  return age < entry.ttlMs;" },
  },
  {
    path: "src/text/pad-start.ts",
    code: [
      "/** Right-align `text` in a field of `width` characters (longer text is kept whole). */",
      "export function padStart(text: string, width: number): string {",
      "  if (text.length >= width) return text;",
      "  const fill = \" \".repeat(width - text.length);",
      "  return fill + text;",
      "}",
      "",
    ],
    bug: { line: 4, text: "  const fill = \" \".repeat(text.length - width);" },
  },
  {
    path: "src/stats/count-by.ts",
    code: [
      "/** How many items fall under each key. */",
      "export function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {",
      "  const counts = new Map<string, number>();",
      "  for (const item of items) {",
      "    const k = key(item);",
      "    counts.set(k, (counts.get(k) ?? 0) + 1);",
      "  }",
      "  return counts;",
      "}",
    ],
    bug: { line: 6, text: "    counts.set(k, (counts.get(k) ?? 1) + 1);" },
  },
  {
    path: "src/util/range.ts",
    code: [
      "/** The numbers from `start` (included) to `end` (excluded), `step` apart. */",
      "export function range(start: number, end: number, step = 1): number[] {",
      "  if (step <= 0) throw new Error(`step must be positive, got ${step}`);",
      "  const out: number[] = [];",
      "  for (let v = start; v < end; v += step) out.push(v);",
      "  return out;",
      "}",
    ],
    bug: { line: 5, text: "  for (let v = start; v <= end; v += step) out.push(v);" },
  },
  {
    path: "src/util/find-index-from.ts",
    code: [
      "/** The first index at or after `from` whose item matches, or -1. */",
      "export function findIndexFrom<T>(items: readonly T[], from: number, match: (item: T) => boolean): number {",
      "  const start = Math.max(0, from);",
      "  for (let i = start; i < items.length; i++) {",
      "    if (match(items[i])) return i;",
      "  }",
      "  return -1;",
      "}",
    ],
    bug: { line: 4, text: "  for (let i = start + 1; i < items.length; i++) {" },
  },
];

/** The file text of a plant, buggy or correct, one string per line. */
export function plantLines(p: BugPlant, buggy: boolean): string[] {
  const lines = [...p.code];
  if (buggy) lines[p.bug.line - 1] = p.bug.text;
  return lines;
}
