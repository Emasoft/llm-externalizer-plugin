/**
 * Unit tests for the mass-scouting search module.
 *
 * Covers:
 *   • detectNamedPattern — every NAMED_PATTERN trigger fires; "urls of
 *     domain X" extracts the domain parameter; non-matches return null
 *   • regexEscape — escapes every regex metachar
 *   • massScoutSearch — explicit regex / named pattern / forceLlm
 *     suppression / forceRegex with named query / forceRegex without
 *     pattern AND non-named query → throws
 *   • massScoutSearch — FTS-only, structured-only (single + AND), combined
 *     FTS + structured, empty (lists all), limit/offset, malformed regex
 *   • Regex hits include line numbers, context windows, and result_json
 *   • Structured filter handles nested JSON paths and SQLite LIKE
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  detectNamedPattern,
  massScoutSearch,
  massScoutSearchXjob,
  regexEscape,
  type SearchFilter,
} from "./search";
import { openRegistry, type Registry } from "./registry";

// ── detectNamedPattern ─────────────────────────────────────────────────

describe("detectNamedPattern", () => {
  it("detects 'find all emails' / 'all emails'", () => {
    /** Two of the canonical phrasings must both fire. */
    expect(detectNamedPattern("find all emails")?.name).toBe("emails");
    expect(detectNamedPattern("all emails in this codebase")?.name).toBe(
      "emails",
    );
  });

  it("detects 'all urls' / 'find all links'", () => {
    /** Synonyms — links + urls both route to the urls pattern. */
    expect(detectNamedPattern("all urls")?.name).toBe("urls");
    expect(detectNamedPattern("find all links")?.name).toBe("urls");
  });

  it("detects 'urls of domain X' and builds a parameterised regex", () => {
    /** The domain becomes part of the resulting regex. */
    const out = detectNamedPattern("urls of domain example.com");
    expect(out?.name).toBe("urls-of-domain");
    // Pattern source must contain the escaped domain.
    expect(out?.pattern.source).toContain("example\\.com");
    // Sanity check: the regex actually matches.
    expect(out?.pattern.test("https://api.example.com/v1")).toBe(true);
    expect(out?.pattern.test("https://other.org/path")).toBe(false);
  });

  it("detects 'all ipv4' / 'all ip addresses'", () => {
    /** Multiple triggers map to the same pattern. */
    expect(detectNamedPattern("all ipv4")?.name).toBe("ipv4");
    expect(detectNamedPattern("all ip addresses")?.name).toBe("ipv4");
  });

  it("flags AWS keys as a security pattern", () => {
    /** The aws-keys pattern is annotated security:true so callers can warn. */
    const out = detectNamedPattern("find all aws keys");
    expect(out?.name).toBe("aws-keys");
    expect(out?.security).toBe(true);
  });

  it("returns null for non-trivial questions", () => {
    /** Anything not on the named-pattern list goes through the LLM/FTS path. */
    expect(detectNamedPattern("which files use react hooks")).toBeNull();
    expect(detectNamedPattern("explain this codebase")).toBeNull();
  });

  it("'urls of domain X' beats plain 'all urls' (specific wins)", () => {
    /** NAMED_PATTERNS order — domain-specific must be checked before generic. */
    const out = detectNamedPattern("all urls of domain github.com");
    expect(out?.name).toBe("urls-of-domain");
  });
});

// ── regexEscape ────────────────────────────────────────────────────────

describe("regexEscape", () => {
  it("escapes every regex metachar", () => {
    /** Spot check the 13 characters that need escaping. */
    expect(regexEscape("a.b+c")).toBe("a\\.b\\+c");
    expect(regexEscape("$^()[]{}")).toBe("\\$\\^\\(\\)\\[\\]\\{\\}");
    expect(regexEscape("foo|bar")).toBe("foo\\|bar");
  });

  it("leaves alphanumerics untouched", () => {
    /** Sanity — escapes must NOT mangle ordinary text. */
    expect(regexEscape("hello-world_42")).toBe("hello-world_42");
  });
});

// ── massScoutSearch ────────────────────────────────────────────────────

describe("massScoutSearch", () => {
  let reg: Registry;

  beforeEach(() => {
    reg = openRegistry({ path: ":memory:" });
  });
  afterEach(() => {
    reg.close();
  });

  /** Helper: register a file (unique body via path stamp) + insert one
   *  result row keyed to it. Returns the inserted file's short_id +
   *  fingerprint so tests can chain assertions. */
  function seed(opts: {
    path: string;
    bodyText: string;
    json: Record<string, unknown>;
    searchableText?: string;
    jobId: string;
  }): { short_id: number; fingerprint: string } {
    const out = reg.registerFile({
      file_path: opts.path,
      source_root: "/x",
      body: Buffer.from(opts.bodyText),
      registered_via: "folder",
    });
    reg.insertResult({
      job_id: opts.jobId,
      file_fingerprint: out.fingerprint,
      short_id: out.short_id,
      result_json: JSON.stringify(opts.json),
      searchable_text: opts.searchableText ?? "",
    });
    return out;
  }

  function seedJob(jobId: string): void {
    reg.createJob({
      job_id: jobId,
      fieldset_name: "test",
      fieldset_json: "{}",
      json_schema: "{}",
      model: "qwen",
      workers: 1,
      source_root: "/x",
    });
  }

  // ── explicit regex ─────────────────────────────────────────────────

  it("explicit regex: matches with line numbers and context windows", () => {
    /** Regex bypasses every other path; matches include line + 80-char window. */
    seedJob("r-1");
    seed({
      jobId: "r-1",
      path: "/x/a.txt",
      bodyText: "alice@example.com\nbob@x.io\n",
      json: {},
    });
    const res = massScoutSearch(reg, {
      jobId: "r-1",
      regex: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
    });
    expect(res.mode).toBe("regex");
    expect(res.regex_reason).toBe("explicit");
    expect(res.hits.length).toBe(1);
    const hit = res.hits[0]!;
    expect(hit.regex_matches!.length).toBe(2);
    expect(hit.regex_matches![0]!.match).toBe("alice@example.com");
    expect(hit.regex_matches![0]!.line).toBe(1);
    expect(hit.regex_matches![1]!.line).toBe(2);
  });

  it("invalid regex string throws with a helpful message", () => {
    /** The error text includes the offending pattern so the caller can fix. */
    seedJob("r-bad");
    expect(() =>
      massScoutSearch(reg, { jobId: "r-bad", regex: "(unbalanced[" }),
    ).toThrow(/invalid regex/i);
  });

  it("explicit regex auto-applies the global flag", () => {
    /** Without `g`, matchAll would return only one match per file. */
    seedJob("r-g");
    seed({
      jobId: "r-g",
      path: "/x/many.txt",
      bodyText: "aa bb aa cc aa",
      json: {},
    });
    const res = massScoutSearch(reg, { jobId: "r-g", regex: "aa" });
    expect(res.hits[0]!.regex_matches!.length).toBe(3);
  });

  // ── named-pattern bypass ───────────────────────────────────────────

  it("named pattern (emails): query alone triggers regex bypass", () => {
    /** "find all emails" → never goes through FTS / LLM. */
    seedJob("np-1");
    seed({
      jobId: "np-1",
      path: "/x/contacts.md",
      bodyText: "carol@y.org and dave@z.com",
      json: {},
    });
    const res = massScoutSearch(reg, {
      jobId: "np-1",
      query: "find all emails",
    });
    expect(res.mode).toBe("regex");
    expect(res.regex_reason).toBe("named:emails");
    expect(res.hits[0]!.regex_matches!.length).toBe(2);
  });

  it("named pattern (urls of domain X): the domain ends up in the regex", () => {
    /** Parameterised pattern — only matches the requested domain. */
    seedJob("np-2");
    seed({
      jobId: "np-2",
      path: "/x/links.md",
      bodyText:
        "see https://github.com/a/b and https://gitlab.com/c/d for details",
      json: {},
    });
    const res = massScoutSearch(reg, {
      jobId: "np-2",
      query: "urls of domain github.com",
    });
    expect(res.mode).toBe("regex");
    expect(res.hits[0]!.regex_matches!.length).toBe(1);
    expect(res.hits[0]!.regex_matches![0]!.match).toContain("github.com/a/b");
  });

  it("forceLlm: suppresses the named-pattern bypass even on a trivial query", () => {
    /** User wants the LLM/FTS path explicitly, e.g. for nuanced semantics. */
    seedJob("np-3");
    seed({
      jobId: "np-3",
      path: "/x/q.md",
      bodyText: "alice@a.com",
      json: { author: "alice" },
      searchableText: "alice author",
    });
    const res = massScoutSearch(reg, {
      jobId: "np-3",
      query: "find all emails",
      forceLlm: true,
    });
    // "find all emails" is not real FTS5 syntax → returns 0 hits, but the
    // mode is FTS, NOT regex — proves the bypass was suppressed.
    expect(res.mode).toBe("fts");
  });

  it("forceRegex without an explicit pattern uses a named pattern when present", () => {
    /** Lets the caller insist on regex semantics without re-typing the regex. */
    seedJob("np-4");
    seed({
      jobId: "np-4",
      path: "/x/c.md",
      bodyText: "10.0.0.1 and 192.168.1.5",
      json: {},
    });
    const res = massScoutSearch(reg, {
      jobId: "np-4",
      query: "all ipv4",
      forceRegex: true,
    });
    expect(res.mode).toBe("regex");
    expect(res.regex_reason).toBe("named:ipv4");
    expect(res.hits[0]!.regex_matches!.length).toBe(2);
  });

  it("forceRegex without pattern AND a non-named query throws", () => {
    /** Defensive: forceRegex requires either a regex or a named-pattern query. */
    seedJob("np-5");
    expect(() =>
      massScoutSearch(reg, {
        jobId: "np-5",
        query: "explain the codebase",
        forceRegex: true,
      }),
    ).toThrow(/no regex provided/i);
  });

  // ── FTS-only ───────────────────────────────────────────────────────

  it("FTS only: ranks results via bm25 and returns snippets", () => {
    /** Two of three rows mention 'react' — both come back, ranked. */
    seedJob("fts-1");
    seed({
      jobId: "fts-1",
      path: "/x/a.md",
      bodyText: "a",
      json: {},
      searchableText: "react hooks tutorial",
    });
    seed({
      jobId: "fts-1",
      path: "/x/b.md",
      bodyText: "b",
      json: {},
      searchableText: "vue composition",
    });
    seed({
      jobId: "fts-1",
      path: "/x/c.md",
      bodyText: "c",
      json: {},
      searchableText: "react components state",
    });
    const res = massScoutSearch(reg, { jobId: "fts-1", query: "react" });
    expect(res.mode).toBe("fts");
    expect(res.hits.length).toBe(2);
    for (const h of res.hits) expect(h.snippet).toMatch(/\[react\]/i);
  });

  it("FTS only: respects the limit", () => {
    /** Caller paginates by walking the ranked output. */
    seedJob("fts-2");
    for (let i = 0; i < 5; i++) {
      seed({
        jobId: "fts-2",
        path: `/x/m${i}.md`,
        bodyText: `body${i}`,
        json: {},
        searchableText: `react demo ${i}`,
      });
    }
    const res = massScoutSearch(reg, {
      jobId: "fts-2",
      query: "react",
      limit: 2,
    });
    expect(res.hits.length).toBe(2);
  });

  // ── Structured-only ────────────────────────────────────────────────

  it("structured only (single filter): boolean equality via JSON path", () => {
    /** Schema allows boolean values in result_json — structured filter checks them. */
    seedJob("s-1");
    seed({
      jobId: "s-1",
      path: "/x/a",
      bodyText: "a",
      json: { is_async: true },
    });
    seed({
      jobId: "s-1",
      path: "/x/b",
      bodyText: "b",
      json: { is_async: false },
    });
    const res = massScoutSearch(reg, {
      jobId: "s-1",
      filters: [{ path: "$.is_async", op: "=", value: 1 }],
    });
    expect(res.mode).toBe("structured");
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.result!["is_async"]).toBe(true);
  });

  it("structured AND: intersection of multiple filters", () => {
    /** Two filters AND'd — only rows matching BOTH come back. */
    seedJob("s-2");
    seed({
      jobId: "s-2",
      path: "/x/a",
      bodyText: "a",
      json: { is_async: true, complexity: 8 },
    });
    seed({
      jobId: "s-2",
      path: "/x/b",
      bodyText: "b",
      json: { is_async: true, complexity: 3 },
    });
    seed({
      jobId: "s-2",
      path: "/x/c",
      bodyText: "c",
      json: { is_async: false, complexity: 9 },
    });
    const filters: SearchFilter[] = [
      { path: "$.is_async", op: "=", value: 1 },
      { path: "$.complexity", op: ">=", value: 5 },
    ];
    const res = massScoutSearch(reg, { jobId: "s-2", filters });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.file_path).toBe("/x/a");
  });

  it("structured: LIKE op with % wildcard", () => {
    /** LIKE 'react-%' matches everything starting with 'react-'. */
    seedJob("s-3");
    seed({
      jobId: "s-3",
      path: "/x/a",
      bodyText: "a",
      json: { framework: "react-hooks" },
    });
    seed({
      jobId: "s-3",
      path: "/x/b",
      bodyText: "b",
      json: { framework: "vue" },
    });
    const res = massScoutSearch(reg, {
      jobId: "s-3",
      filters: [{ path: "$.framework", op: "LIKE", value: "react-%" }],
    });
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.result!["framework"]).toBe("react-hooks");
  });

  // ── Combined ───────────────────────────────────────────────────────

  it("combined: FTS narrows the candidate set, structured filter prunes further", () => {
    /** "react" matches 2 rows; structured filter keeps only the async one. */
    seedJob("c-1");
    seed({
      jobId: "c-1",
      path: "/x/a",
      bodyText: "a",
      json: { is_async: true },
      searchableText: "react hooks",
    });
    seed({
      jobId: "c-1",
      path: "/x/b",
      bodyText: "b",
      json: { is_async: false },
      searchableText: "react components",
    });
    seed({
      jobId: "c-1",
      path: "/x/c",
      bodyText: "c",
      json: { is_async: true },
      searchableText: "vue composition",
    });
    const res = massScoutSearch(reg, {
      jobId: "c-1",
      query: "react",
      filters: [{ path: "$.is_async", op: "=", value: 1 }],
    });
    expect(res.mode).toBe("combined");
    expect(res.hits.length).toBe(1);
    expect(res.hits[0]!.file_path).toBe("/x/a");
  });

  // ── Empty / list-all ───────────────────────────────────────────────

  it("no query and no filters: lists every result, paginated", () => {
    /** The default response when the caller wants to enumerate the job. */
    seedJob("e-1");
    for (let i = 0; i < 5; i++) {
      seed({
        jobId: "e-1",
        path: `/x/${i}`,
        bodyText: String(i),
        json: { i },
      });
    }
    const res = massScoutSearch(reg, { jobId: "e-1", limit: 3 });
    expect(res.mode).toBe("structured");
    expect(res.hits.length).toBe(3);
    expect(res.total_examined).toBe(5);
  });

  it("structured limit + offset paginate over filtered rows", () => {
    /** Page 2 of 5 with limit=2 returns rows 3 and 4. */
    seedJob("p-1");
    for (let i = 0; i < 5; i++) {
      seed({
        jobId: "p-1",
        path: `/x/${i}`,
        bodyText: `body-${i}`,
        json: { i, ok: true },
      });
    }
    const res = massScoutSearch(reg, {
      jobId: "p-1",
      filters: [{ path: "$.ok", op: "=", value: 1 }],
      limit: 2,
      offset: 2,
    });
    expect(res.hits.length).toBe(2);
    // Assert the offset actually skipped rows 0 and 1 — without these
    // checks, a bug that ignores `offset` and returns the first two
    // matching rows would still pass `length === 2`.
    expect(res.hits[0]!.file_path).toBe("/x/2");
    expect(res.hits[1]!.file_path).toBe("/x/3");
    expect(res.hits[0]!.result!["i"]).toBe(2);
    expect(res.hits[1]!.result!["i"]).toBe(3);
  });
});

// ── massScoutSearchXjob ────────────────────────────────────────────────

describe("massScoutSearchXjob", () => {
  let reg: Registry;

  beforeEach(() => {
    reg = openRegistry({ path: ":memory:" });
  });
  afterEach(() => {
    reg.close();
  });

  function seedJob(jobId: string): void {
    reg.createJob({
      job_id: jobId,
      fieldset_name: "test",
      fieldset_json: "{}",
      json_schema: "{}",
      model: "qwen",
      workers: 1,
      source_root: "/x",
    });
  }

  function seedRow(opts: {
    jobId: string;
    path: string;
    bodyText: string;
    json: Record<string, unknown>;
    searchableText?: string;
  }): void {
    const out = reg.registerFile({
      file_path: opts.path,
      source_root: "/x",
      body: Buffer.from(opts.bodyText),
      registered_via: "folder",
    });
    reg.insertResult({
      job_id: opts.jobId,
      file_fingerprint: out.fingerprint,
      short_id: out.short_id,
      result_json: JSON.stringify(opts.json),
      searchable_text: opts.searchableText ?? "",
    });
  }

  it("merges hits from multiple jobs and tags each with job_id", () => {
    /** Each hit must carry the job it came from so the caller can route. */
    seedJob("xj-a");
    seedJob("xj-b");
    seedRow({
      jobId: "xj-a",
      path: "/x/a.md",
      bodyText: "react in a",
      json: { framework: "react" },
      searchableText: "react in a",
    });
    seedRow({
      jobId: "xj-b",
      path: "/x/b.md",
      bodyText: "react in b",
      json: { framework: "react" },
      searchableText: "react in b",
    });
    const res = massScoutSearchXjob(reg, {
      jobIds: ["xj-a", "xj-b"],
      query: "react",
    });
    expect(res.hits.length).toBe(2);
    const ids = res.hits.map((h) => h.job_id).sort();
    expect(ids).toEqual(["xj-a", "xj-b"]);
    expect(res.per_job["xj-a"]!.hits).toBe(1);
    expect(res.per_job["xj-b"]!.hits).toBe(1);
  });

  it("regex bypass fires across every job", () => {
    /** "find all emails" must hit jobA and jobB independently. */
    seedJob("xj-r1");
    seedJob("xj-r2");
    seedRow({
      jobId: "xj-r1",
      path: "/x/p1",
      bodyText: "alice@x.com",
      json: {},
    });
    seedRow({
      jobId: "xj-r2",
      path: "/x/p2",
      bodyText: "bob@y.org",
      json: {},
    });
    const res = massScoutSearchXjob(reg, {
      jobIds: ["xj-r1", "xj-r2"],
      query: "find all emails",
    });
    expect(res.mode).toBe("regex");
    expect(res.regex_reason).toBe("named:emails");
    expect(res.hits.length).toBe(2);
  });

  it("rejects an empty jobIds list", () => {
    /** Defensive: no jobs means nothing to merge — surface clearly. */
    expect(() =>
      massScoutSearchXjob(reg, { jobIds: [], query: "anything" }),
    ).toThrow(/must not be empty/i);
  });

  it("limitMerged caps the final list", () => {
    /** Per-job limit may oversample; merged limit is the user-visible cap. */
    seedJob("xj-l1");
    seedJob("xj-l2");
    for (let i = 0; i < 5; i++) {
      seedRow({
        jobId: "xj-l1",
        path: `/x/a${i}`,
        bodyText: `body-${i}`,
        json: {},
        searchableText: `react demo ${i}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      seedRow({
        jobId: "xj-l2",
        path: `/x/b${i}`,
        bodyText: `body-${i}-b`,
        json: {},
        searchableText: `react demo ${i}`,
      });
    }
    const res = massScoutSearchXjob(reg, {
      jobIds: ["xj-l1", "xj-l2"],
      query: "react",
      limitPerJob: 5,
      limitMerged: 3,
    });
    expect(res.hits.length).toBe(3);
  });
});
