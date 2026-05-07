/**
 * mass-scouting search — query the per-job results in three modes:
 *
 *   1. **regex** — programmatic regex over the cached file bodies. Triggered
 *      automatically for trivial queries ("find all emails", "all urls of
 *      domain X", IPs, phone numbers, semver, etc. — see `NAMED_PATTERNS`)
 *      OR explicitly via `regex: "..."`. The LLM is never invoked. Matches
 *      include line numbers and an 80-char window for context.
 *
 *   2. **fts** — FTS5 query against the `mass_scout_results_fts` virtual
 *      table populated by the scout phase. Returns `bm25`-ranked snippets.
 *
 *   3. **structured** — JSON1 path filters against `result_json`, e.g.
 *      `{path: "$.is_async", op: "=", value: true}`. Multiple filters are
 *      AND'd together. Combinable with `query` (FTS) — FTS hits are first,
 *      then structured predicates are applied in JS.
 *
 * `forceLlm: true` skips the regex-bypass heuristic. `forceRegex: true`
 * with an explicit `regex` runs that pattern verbatim.
 *
 * Body bytes are read from the registry's cache (single-source-of-truth);
 * disk is never re-touched per the §15 token-frugality directive.
 */

import type {
  Registry,
  RegistryRow,
  ResultRow,
} from "./registry";

// ── Public types ───────────────────────────────────────────────────────

export type SearchMode = "regex" | "fts" | "structured" | "combined";

/** A JSON1 path predicate. The path is validated by `Registry.searchByJsonExtract`. */
export interface SearchFilter {
  path: string;
  op: ">" | ">=" | "<" | "<=" | "=" | "!=" | "LIKE";
  value: string | number | boolean | null;
}

export interface SearchQuery {
  jobId: string;
  /** Plain natural-language or FTS5 query. Combined with `regex` only via force flags. */
  query?: string;
  /** Explicit regex pattern (string form, JS regex). Implies regex mode. */
  regex?: string;
  /** Skip the regex-bypass heuristic — use FTS / structured only. */
  forceLlm?: boolean;
  /** Force regex mode. Requires `regex` OR a `query` that matches a named pattern. */
  forceRegex?: boolean;
  /** AND'd structured predicates. */
  filters?: SearchFilter[];
  /** Result cap. Default 50 (matches blueprint §6.4 default). */
  limit?: number;
  /** Skip the first N hits (FTS / structured only). */
  offset?: number;
}

export interface RegexMatch {
  /** 1-based line number where the match starts. */
  line: number;
  /** Up to 80 surrounding chars centered on the match. */
  context: string;
  /** Exact matched string. */
  match: string;
}

export interface SearchHit {
  short_id: number;
  file_path: string;
  file_fingerprint: string;
  /** Per-mode evidence — populated based on which mode produced the hit. */
  mode: SearchMode;
  /** FTS5 bm25 — lower = better match. Present only for `fts`/`combined` hits. */
  rank?: number;
  /** FTS5 snippet with `[match]` highlighting. */
  snippet?: string;
  /** Regex matches with line + context. Present only for `regex` hits. */
  regex_matches?: RegexMatch[];
  /** Parsed `result_json` (every mode populates this). */
  result?: Record<string, unknown>;
}

export interface SearchResponse {
  jobId: string;
  mode: SearchMode;
  query?: string;
  /**
   * If a regex bypass fired, the pattern that was actually run. Lets the
   * caller inspect what the heuristic decided.
   */
  regex_pattern?: string;
  /**
   * If regex mode bypassed the LLM, why? "explicit" (`regex` arg supplied),
   * "named:<name>" (matched a NAMED_PATTERN entry), "force-with-pattern"
   * (`forceRegex` + `regex`), or undefined (regex mode was not used).
   */
  regex_reason?: string;
  hits: SearchHit[];
  /** Total candidate rows examined (pre-limit). Useful for "X+ matches" UI. */
  total_examined: number;
}

// ── Built-in regex patterns (TRDD §15) ─────────────────────────────────

interface NamedPattern {
  /** One or more triggers — case-insensitive, normalised whitespace. */
  triggers: RegExp[];
  /** A function that returns the regex to run, or `null` if it can't be built. */
  build: (query: string) => RegExp | null;
  /** Identifier for the result's `regex_reason` field. */
  name: string;
  /** Optional flag — set true for security-relevant patterns (logs at WARN). */
  security?: boolean;
}

/** Escape a literal string for use inside a RegExp. */
export function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NAMED_PATTERNS: NamedPattern[] = [
  {
    name: "emails",
    triggers: [/\ball\s+emails?\b/i, /\bfind\s+emails?\b/i, /\bemail\s+addresses?\b/i],
    build: () => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    name: "urls-of-domain",
    triggers: [
      /\b(?:urls?|links?)\s+(?:of|to|on|for)\s+(?:domain\s+)?(\S+)/i,
      /\blinks?\s+(?:to|on)\s+(\S+)/i,
    ],
    build: (query) => {
      const m =
        query.match(
          /\b(?:urls?|links?)\s+(?:of|to|on|for)\s+(?:domain\s+)?([\w.-]+)/i,
        ) ?? query.match(/\blinks?\s+(?:to|on)\s+([\w.-]+)/i);
      const domain = m?.[1];
      if (!domain) return null;
      const escaped = regexEscape(domain.replace(/\.$/, ""));
      return new RegExp(`https?://[^\\s'"<>]*${escaped}[^\\s'"<>]*`, "g");
    },
  },
  {
    name: "urls",
    triggers: [/\ball\s+urls?\b/i, /\bfind\s+urls?\b/i, /\ball\s+links?\b/i],
    build: () => /https?:\/\/[^\s'"<>]+/g,
  },
  {
    name: "ipv4",
    triggers: [/\ball\s+ipv4\b/i, /\ball\s+ip\s+addresses?\b/i, /\bfind\s+ips?\b/i],
    // Anchored on word boundaries — keeps `1.2.3.4.5` from being read as "1.2.3.4".
    build: () => /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  {
    name: "phone",
    triggers: [/\ball\s+phone\s+numbers?\b/i, /\bfind\s+phones?\b/i],
    build: () => /\+?\d[\d\s().-]{6,}\d/g,
  },
  {
    name: "hex-colors",
    triggers: [/\ball\s+hex\s+colou?rs?\b/i, /\bfind\s+hex\s+colou?rs?\b/i],
    build: () => /#[0-9A-Fa-f]{3,8}\b/g,
  },
  {
    name: "semver",
    triggers: [/\ball\s+semver\b/i, /\bversion\s+strings?\b/i],
    build: () => /\bv?\d+\.\d+\.\d+(?:-[\w.]+)?\b/g,
  },
  {
    name: "github-repos",
    triggers: [/\ball\s+github\s+repos?\b/i, /\bfind\s+github\s+repos?\b/i],
    build: () => /\bgithub\.com\/[\w.-]+\/[\w.-]+\b/g,
  },
  {
    name: "aws-keys",
    triggers: [/\ball\s+aws\s+keys?\b/i, /\bfind\s+aws\s+keys?\b/i],
    build: () => /\bAKIA[0-9A-Z]{16}\b/g,
    security: true,
  },
];

/**
 * Pick the first NAMED_PATTERN whose triggers match the query, or null.
 * Order in `NAMED_PATTERNS` is significant — more specific patterns
 * (`urls-of-domain`) come before more general ones (`urls`).
 */
export function detectNamedPattern(
  query: string,
): { pattern: RegExp; name: string; security?: boolean } | null {
  const normalised = query.replace(/\s+/g, " ").trim();
  for (const np of NAMED_PATTERNS) {
    if (np.triggers.some((t) => t.test(normalised))) {
      const re = np.build(normalised);
      if (re) {
        return { pattern: re, name: np.name, security: np.security };
      }
    }
  }
  return null;
}

// ── Regex search core ──────────────────────────────────────────────────

/**
 * Apply a regex over the cached body of every result row in a job. Returns
 * hits with line numbers + 80-char context windows. Pure aside from the
 * registry's body-cache reads.
 *
 * The regex MUST have the `g` flag — otherwise `matchAll` would only return
 * a single match per file. We coerce the flags here to be safe.
 */
function regexOverBodies(
  reg: Registry,
  jobId: string,
  patternIn: RegExp,
  limit: number,
): { hits: SearchHit[]; total_examined: number } {
  const flags = patternIn.flags.includes("g")
    ? patternIn.flags
    : `${patternIn.flags}g`;
  const pattern = new RegExp(patternIn.source, flags);

  const results = reg.listResultsByJob(jobId);
  const hits: SearchHit[] = [];
  let examined = 0;
  for (const r of results) {
    examined++;
    if (hits.length >= limit) break;
    const body = reg.readBody(r.file_fingerprint);
    if (!body) continue;
    const text = body.toString("utf-8");
    const matches = collectRegexMatches(text, pattern);
    if (matches.length === 0) continue;
    const fileRow = reg.getByFingerprint(r.file_fingerprint);
    if (!fileRow) continue;
    hits.push({
      short_id: r.short_id,
      file_path: fileRow.file_path,
      file_fingerprint: r.file_fingerprint,
      mode: "regex",
      regex_matches: matches,
      result: parseResultJson(r.result_json),
    });
  }
  return { hits, total_examined: examined };
}

/**
 * Collect every match of `pattern` in `text`. Each match becomes a
 * `RegexMatch` with the 1-based line number and an up-to-80-char context
 * centered on the match (40 chars before, the match itself, then up to 40
 * chars of trailer).
 */
function collectRegexMatches(text: string, pattern: RegExp): RegexMatch[] {
  const out: RegexMatch[] = [];
  for (const m of text.matchAll(pattern)) {
    const offset = m.index ?? 0;
    const matchStr = m[0];
    let line = 1;
    for (let i = 0; i < offset; i++) {
      if (text.charCodeAt(i) === 10) line++;
    }
    const start = Math.max(0, offset - 40);
    const end = Math.min(text.length, offset + matchStr.length + 40);
    out.push({
      line,
      context: text.slice(start, end),
      match: matchStr,
    });
  }
  return out;
}

// ── Structured filters ─────────────────────────────────────────────────

/**
 * Apply a single structured filter, then iteratively narrow by every
 * remaining filter via JS-side intersection on `result_json`. The first
 * filter goes through SQLite (uses the json_extract index path); subsequent
 * ones are JS to keep the query simple. Cardinality of the first filter
 * dictates cost — caller can pre-sort filters to put the most selective
 * one first if performance matters.
 */
function structuredOnly(
  reg: Registry,
  jobId: string,
  filters: SearchFilter[],
  limit: number,
  offset: number,
): { hits: SearchHit[]; total_examined: number } {
  if (filters.length === 0) {
    // Empty filter list collapses to "all results" — paginate.
    const rows = reg.listResultsByJob(jobId, { limit, offset });
    return {
      hits: rows.map((r) => resultRowToHit(reg, r, "structured")),
      total_examined: reg.countResultsByJob(jobId),
    };
  }
  const [head, ...rest] = filters;
  // Use a generous server-side limit so the JS-side filtering has room to work.
  // We'll re-cap to `limit` after JS filtering.
  const candidates = reg.searchByJsonExtract(
    jobId,
    head!.path,
    head!.op,
    head!.value,
    { limit: limit + offset + 10_000, offset: 0 },
  );
  const matched = candidates.filter((r) => {
    const parsed = parseResultJson(r.result_json);
    return rest.every((f) => evaluateFilter(parsed, f));
  });
  const paginated = matched.slice(offset, offset + limit);
  return {
    hits: paginated.map((r) => resultRowToHit(reg, r, "structured")),
    total_examined: candidates.length,
  };
}

/** Evaluate one filter against a parsed result object (JS side). */
function evaluateFilter(
  parsed: Record<string, unknown> | null,
  filter: SearchFilter,
): boolean {
  if (parsed == null) return false;
  // Path is `$.foo` or `$.foo[0]` — strip the leading `$.` and walk.
  const segments = filter.path.replace(/^\$\.?/, "").split(/\.|\[(\d+)\]/).filter(Boolean);
  let cur: unknown = parsed;
  for (const seg of segments) {
    if (cur == null) return false;
    if (/^\d+$/.test(seg)) {
      if (!Array.isArray(cur)) return false;
      cur = cur[Number(seg)];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return false;
    }
  }
  return compareValues(cur, filter.op, filter.value);
}

function compareValues(
  actual: unknown,
  op: SearchFilter["op"],
  expected: SearchFilter["value"],
): boolean {
  // Bool actuals show up as JS booleans; convert SQLite-style 0/1 expected to bool first.
  const a = typeof actual === "boolean" && typeof expected === "number"
    ? actual ? 1 : 0
    : actual;
  switch (op) {
    case "=":
      return a === expected;
    case "!=":
      return a !== expected;
    case ">":
      return typeof a === "number" && typeof expected === "number" && a > expected;
    case ">=":
      return typeof a === "number" && typeof expected === "number" && a >= expected;
    case "<":
      return typeof a === "number" && typeof expected === "number" && a < expected;
    case "<=":
      return typeof a === "number" && typeof expected === "number" && a <= expected;
    case "LIKE": {
      if (typeof a !== "string" || typeof expected !== "string") return false;
      // SQLite LIKE: % = any, _ = single. Approximate via a regex.
      // The regex-meta escape excludes `%` and `_` so we can substitute them next.
      const re = new RegExp(
        `^${expected
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/%/g, ".*")
          .replace(/_/g, ".")}$`,
        "i",
      );
      return re.test(a);
    }
  }
}

// ── FTS + combined ─────────────────────────────────────────────────────

function ftsOnly(
  reg: Registry,
  jobId: string,
  query: string,
  limit: number,
): { hits: SearchHit[]; total_examined: number } {
  const ftsHits = reg.searchFtsByJob(jobId, query, limit);
  const out: SearchHit[] = [];
  for (const h of ftsHits) {
    const fileRow = reg.getByFingerprint(h.file_fingerprint);
    const result = reg.getResult(jobId, h.file_fingerprint);
    if (!fileRow || !result) continue;
    out.push({
      short_id: h.short_id,
      file_path: fileRow.file_path,
      file_fingerprint: h.file_fingerprint,
      mode: "fts",
      rank: h.rank,
      snippet: h.snippet,
      result: parseResultJson(result.result_json),
    });
  }
  return { hits: out, total_examined: ftsHits.length };
}

function combined(
  reg: Registry,
  jobId: string,
  query: string,
  filters: SearchFilter[],
  limit: number,
): { hits: SearchHit[]; total_examined: number } {
  // FTS first to get a ranked candidate list, then narrow by structured
  // filters in JS. Pull more candidates than `limit` because some will
  // be dropped by the structured filter.
  const ftsCandidates = reg.searchFtsByJob(jobId, query, limit * 5);
  const examined = ftsCandidates.length;
  const out: SearchHit[] = [];
  for (const h of ftsCandidates) {
    if (out.length >= limit) break;
    const result = reg.getResult(jobId, h.file_fingerprint);
    if (!result) continue;
    const parsed = parseResultJson(result.result_json);
    if (!filters.every((f) => evaluateFilter(parsed, f))) continue;
    const fileRow = reg.getByFingerprint(h.file_fingerprint);
    if (!fileRow) continue;
    out.push({
      short_id: h.short_id,
      file_path: fileRow.file_path,
      file_fingerprint: h.file_fingerprint,
      mode: "combined",
      rank: h.rank,
      snippet: h.snippet,
      result: parsed,
    });
  }
  return { hits: out, total_examined: examined };
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseResultJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v != null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function resultRowToHit(
  reg: Registry,
  r: ResultRow,
  mode: SearchMode,
): SearchHit {
  const fileRow: RegistryRow | null = reg.getByFingerprint(r.file_fingerprint);
  return {
    short_id: r.short_id,
    file_path: fileRow?.file_path ?? "(unknown)",
    file_fingerprint: r.file_fingerprint,
    mode,
    result: parseResultJson(r.result_json),
  };
}

// ── Public entry point ─────────────────────────────────────────────────

export function massScoutSearch(
  reg: Registry,
  q: SearchQuery,
): SearchResponse {
  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;

  // 1. Explicit regex (highest priority).
  if (q.regex !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(q.regex, "g");
    } catch (e) {
      throw new Error(
        `mass_scout_search: invalid regex ${JSON.stringify(q.regex)}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    const { hits, total_examined } = regexOverBodies(
      reg,
      q.jobId,
      pattern,
      limit,
    );
    return {
      jobId: q.jobId,
      mode: "regex",
      query: q.query,
      regex_pattern: q.regex,
      regex_reason: q.forceRegex ? "force-with-pattern" : "explicit",
      hits,
      total_examined,
    };
  }

  // 2. forceRegex without an explicit pattern — only valid when the query
  //    matches a named pattern.
  if (q.forceRegex && q.query) {
    const named = detectNamedPattern(q.query);
    if (!named) {
      throw new Error(
        `mass_scout_search: forceRegex set but no regex provided and no named pattern matched query ${JSON.stringify(q.query)}`,
      );
    }
    const { hits, total_examined } = regexOverBodies(
      reg,
      q.jobId,
      named.pattern,
      limit,
    );
    return {
      jobId: q.jobId,
      mode: "regex",
      query: q.query,
      regex_pattern: named.pattern.source,
      regex_reason: `named:${named.name}`,
      hits,
      total_examined,
    };
  }

  // 3. Heuristic: query matches a built-in trivial-query pattern (and
  //    forceLlm is NOT set) → take the regex shortcut.
  if (q.query && !q.forceLlm) {
    const named = detectNamedPattern(q.query);
    if (named) {
      const { hits, total_examined } = regexOverBodies(
        reg,
        q.jobId,
        named.pattern,
        limit,
      );
      return {
        jobId: q.jobId,
        mode: "regex",
        query: q.query,
        regex_pattern: named.pattern.source,
        regex_reason: `named:${named.name}`,
        hits,
        total_examined,
      };
    }
  }

  // 4. Combined FTS + structured.
  if (q.query && q.filters && q.filters.length > 0) {
    const { hits, total_examined } = combined(
      reg,
      q.jobId,
      q.query,
      q.filters,
      limit,
    );
    return {
      jobId: q.jobId,
      mode: "combined",
      query: q.query,
      hits,
      total_examined,
    };
  }

  // 5. Structured-only.
  if (q.filters && q.filters.length > 0) {
    const { hits, total_examined } = structuredOnly(
      reg,
      q.jobId,
      q.filters,
      limit,
      offset,
    );
    return {
      jobId: q.jobId,
      mode: "structured",
      hits,
      total_examined,
    };
  }

  // 6. FTS-only.
  if (q.query) {
    const { hits, total_examined } = ftsOnly(reg, q.jobId, q.query, limit);
    return {
      jobId: q.jobId,
      mode: "fts",
      query: q.query,
      hits,
      total_examined,
    };
  }

  // 7. No query, no filters — list everything (paginated).
  const { hits, total_examined } = structuredOnly(
    reg,
    q.jobId,
    [],
    limit,
    offset,
  );
  return {
    jobId: q.jobId,
    mode: "structured",
    hits,
    total_examined,
  };
}

// ── Cross-job search (TRDD §15 Q7) ─────────────────────────────────────

export interface XjobSearchQuery {
  jobIds: string[];
  query?: string;
  regex?: string;
  forceLlm?: boolean;
  forceRegex?: boolean;
  filters?: SearchFilter[];
  /** Per-job hit cap before merging. Default 50. */
  limitPerJob?: number;
  /** Final cap on the merged hit list. Default 200. */
  limitMerged?: number;
}

export interface XjobSearchHit extends SearchHit {
  job_id: string;
}

export interface XjobSearchResponse {
  jobIds: string[];
  mode: SearchMode;
  query?: string;
  regex_pattern?: string;
  regex_reason?: string;
  /** Merged + deduplicated hits across every job. */
  hits: XjobSearchHit[];
  /** Per-job total examined counts. */
  per_job: Record<string, { mode: SearchMode; total_examined: number; hits: number }>;
  total_examined: number;
}

/**
 * Run `massScoutSearch` against every job_id in `jobIds` and merge the
 * results. The same fingerprint can appear in two jobs — both rows are
 * preserved (different `job_id`s = different scouts of the same file with
 * potentially different fieldsets, so distinct findings).
 *
 * Modes are decided per-job: a regex bypass on one job's query produces
 * a `regex` hit list there, while another job that ran without a regex
 * trigger may return `fts`/`structured` hits. The response's top-level
 * `mode` is the most-specific common mode (regex wins if any job used it),
 * which lets a caller render them uniformly.
 */
export function massScoutSearchXjob(
  reg: Registry,
  q: XjobSearchQuery,
): XjobSearchResponse {
  if (q.jobIds.length === 0) {
    throw new Error("massScoutSearchXjob: jobIds must not be empty");
  }
  const limitPerJob = q.limitPerJob ?? 50;
  const limitMerged = q.limitMerged ?? 200;

  const merged: XjobSearchHit[] = [];
  const perJob: Record<
    string,
    { mode: SearchMode; total_examined: number; hits: number }
  > = {};
  let unifiedRegexPattern: string | undefined;
  let unifiedRegexReason: string | undefined;
  const modesSeen = new Set<SearchMode>();

  for (const jobId of q.jobIds) {
    const sub = massScoutSearch(reg, {
      jobId,
      query: q.query,
      regex: q.regex,
      forceLlm: q.forceLlm,
      forceRegex: q.forceRegex,
      filters: q.filters,
      limit: limitPerJob,
    });
    perJob[jobId] = {
      mode: sub.mode,
      total_examined: sub.total_examined,
      hits: sub.hits.length,
    };
    modesSeen.add(sub.mode);
    if (sub.regex_pattern && unifiedRegexPattern === undefined) {
      unifiedRegexPattern = sub.regex_pattern;
      unifiedRegexReason = sub.regex_reason;
    }
    for (const h of sub.hits) {
      merged.push({ ...h, job_id: jobId });
    }
  }

  // Sort: FTS rank ascending where available, otherwise stable insertion order.
  merged.sort((a, b) => {
    if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
    if (a.rank !== undefined) return -1;
    if (b.rank !== undefined) return 1;
    return 0;
  });

  return {
    jobIds: q.jobIds,
    mode: pickUnifiedMode(modesSeen),
    query: q.query,
    regex_pattern: unifiedRegexPattern,
    regex_reason: unifiedRegexReason,
    hits: merged.slice(0, limitMerged),
    per_job: perJob,
    total_examined: Object.values(perJob).reduce(
      (acc, v) => acc + v.total_examined,
      0,
    ),
  };
}

/**
 * Pick the "most specific" mode across the per-job results. Regex wins
 * (means at least one job took the bypass), then combined, then fts,
 * then structured.
 */
function pickUnifiedMode(seen: Set<SearchMode>): SearchMode {
  if (seen.has("regex")) return "regex";
  if (seen.has("combined")) return "combined";
  if (seen.has("fts")) return "fts";
  return "structured";
}
