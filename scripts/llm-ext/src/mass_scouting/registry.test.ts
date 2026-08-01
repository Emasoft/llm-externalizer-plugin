/**
 * Unit tests for the mass-scouting persistent registry.
 *
 * Covers:
 *   • openRegistry — schema migrations applied, idempotent re-open
 *   • registerFile — single + bulk + idempotent on identical content
 *   • body cache — read-back returns the exact bytes we registered
 *   • updateClassification — bucket / language / format / frontmatter set
 *   • lookup helpers — getByFingerprint / getByShortId / getByPath
 *   • listEligible — total + per-bucket filter
 *   • recordSkipped + listSkipped — phase filter, all-phases listing
 *   • countFiles + countByBucket — accurate aggregates
 *   • fingerprintOf — stable, sensitive to body changes
 *
 * All tests use ":memory:" databases so they're hermetic and parallel-safe.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRegistry, Registry, SCHEMA_VERSION } from "./registry";

let reg: Registry;

beforeEach(() => {
  reg = openRegistry({ path: ":memory:" });
});

afterEach(() => {
  reg.close();
});

// ── openRegistry / migrations ──────────────────────────────────────────

describe("openRegistry", () => {
  it("applies every migration up to SCHEMA_VERSION", () => {
    /** schema_version must contain one row per applied migration (1..SCHEMA_VERSION). */
    const rows = reg.db
      .prepare("SELECT version FROM schema_version ORDER BY version")
      .all() as { version: number }[];
    const expected = Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1);
    expect(rows.map((r) => r.version)).toEqual(expected);
  });

  it("creates all the expected tables (v1 + v2)", () => {
    /** v1 = file/body/skipped/schema_version, v2 = jobs/results/results_fts. */
    const names = (
      reg.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','virtual')",
        )
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"));
    expect(names).toEqual(
      expect.arrayContaining([
        "file_short_id",
        "file_body_cache",
        "mass_scout_skipped",
        "schema_version",
        "mass_scout_jobs",
        "mass_scout_results",
        "mass_scout_results_fts",
      ]),
    );
  });

  it("is idempotent — running migrations a second time is a no-op", () => {
    /**
     * Re-opening an existing registry must not duplicate tables or rows.
     * `:memory:` databases are unique per connection, so we use a real
     * temp file: open once to apply migrations, close, then re-open the
     * same file to exercise the "already at SCHEMA_VERSION" branch in
     * applyMigrations.
     */
    const dir = mkdtempSync(join(tmpdir(), "registry-idempotent-"));
    const dbPath = join(dir, "reg.db");
    try {
      const first = openRegistry({ path: dbPath });
      const firstRows = first.db
        .prepare("SELECT COUNT(*) AS n FROM schema_version")
        .get() as { n: number };
      expect(firstRows.n).toBe(SCHEMA_VERSION);
      first.close();

      // Second open hits the SAME file — applyMigrations must skip every
      // already-applied migration and leave the row count unchanged.
      const second = openRegistry({ path: dbPath });
      const secondRows = second.db
        .prepare("SELECT COUNT(*) AS n FROM schema_version")
        .get() as { n: number };
      expect(secondRows.n).toBe(SCHEMA_VERSION);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── registerFile ───────────────────────────────────────────────────────

describe("registerFile", () => {
  it("inserts a new row and returns short_id + fingerprint", () => {
    /** First registration of a body produces a fresh short_id. */
    const out = reg.registerFile({
      file_path: "/tmp/a.ts",
      source_root: "/tmp",
      body: Buffer.from("hello"),
      registered_via: "folder",
    });
    expect(out.already_registered).toBe(false);
    expect(out.short_id).toBeGreaterThan(0);
    expect(out.fingerprint).toMatch(/^[a-f0-9]{40}$/);
  });

  it("is idempotent on identical content (same fingerprint → same short_id)", () => {
    /** Re-registering the same bytes must NOT create a duplicate row. */
    const a = reg.registerFile({
      file_path: "/tmp/a.ts",
      source_root: "/tmp",
      body: Buffer.from("hello"),
      registered_via: "folder",
    });
    const b = reg.registerFile({
      file_path: "/tmp/a.ts",
      source_root: "/tmp",
      body: Buffer.from("hello"),
      registered_via: "folder",
    });
    expect(b.already_registered).toBe(true);
    expect(b.short_id).toBe(a.short_id);
    expect(reg.countFiles()).toBe(1);
  });

  it("treats different content as different files even at the same path", () => {
    /** Identity is content-based — moving/editing a file produces a new short_id. */
    const a = reg.registerFile({
      file_path: "/tmp/a.ts",
      source_root: "/tmp",
      body: Buffer.from("v1"),
      registered_via: "folder",
    });
    const b = reg.registerFile({
      file_path: "/tmp/a.ts",
      source_root: "/tmp",
      body: Buffer.from("v2"),
      registered_via: "folder",
    });
    expect(b.short_id).not.toBe(a.short_id);
    expect(reg.countFiles()).toBe(2);
  });

  it("rejects an invalid registered_via value via the CHECK constraint", () => {
    /** registered_via is enum-constrained at the SQL layer. */
    expect(() =>
      reg.registerFile({
        file_path: "/tmp/x",
        source_root: "/tmp",
        body: Buffer.from("hi"),
        registered_via: "weird" as never,
      }),
    ).toThrow();
  });

  it("registerFiles batches inside a single transaction", () => {
    /** Bulk-register is the hot path — must succeed atomically. */
    const out = reg.registerFiles([
      {
        file_path: "/tmp/1",
        source_root: "/tmp",
        body: Buffer.from("a"),
        registered_via: "folder",
      },
      {
        file_path: "/tmp/2",
        source_root: "/tmp",
        body: Buffer.from("b"),
        registered_via: "folder",
      },
      {
        file_path: "/tmp/3",
        source_root: "/tmp",
        body: Buffer.from("c"),
        registered_via: "folder",
      },
    ]);
    expect(out).toHaveLength(3);
    expect(reg.countFiles()).toBe(3);
  });
});

// ── body cache ─────────────────────────────────────────────────────────

describe("body cache", () => {
  it("readBody returns the exact bytes registered", () => {
    /** Token-frugality: future phases must read from cache, not disk. */
    const body = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x7f]);
    const out = reg.registerFile({
      file_path: "/tmp/bin",
      source_root: "/tmp",
      body,
      registered_via: "folder",
    });
    const read = reg.readBody(out.fingerprint);
    expect(read).not.toBeNull();
    expect(read!.equals(body)).toBe(true);
  });

  it("readBody returns null for unknown fingerprint", () => {
    /** Lookup miss is null, not an error. */
    expect(reg.readBody("0".repeat(40))).toBeNull();
  });

  it("cacheBody overwrites an existing entry", () => {
    /** Phase boundaries may re-seed the cache; INSERT OR REPLACE handles that. */
    const body = Buffer.from("v1");
    const out = reg.registerFile({
      file_path: "/tmp/x",
      source_root: "/tmp",
      body,
      registered_via: "folder",
    });
    reg.cacheBody(out.fingerprint, Buffer.from("v2-cached"));
    const read = reg.readBody(out.fingerprint);
    expect(read!.toString()).toBe("v2-cached");
  });

  it("deleteBody removes the cache entry without removing the file row", () => {
    /** Cache eviction is independent of registry pruning. */
    const out = reg.registerFile({
      file_path: "/tmp/x",
      source_root: "/tmp",
      body: Buffer.from("hi"),
      registered_via: "folder",
    });
    reg.deleteBody(out.fingerprint);
    expect(reg.readBody(out.fingerprint)).toBeNull();
    expect(reg.getByFingerprint(out.fingerprint)).not.toBeNull();
  });
});

// ── updateClassification ───────────────────────────────────────────────

describe("updateClassification", () => {
  it("writes bucket, language, format, frontmatter flag", () => {
    /** Preclassify writes here; scout reads back via listEligible. */
    const out = reg.registerFile({
      file_path: "/tmp/x.ts",
      source_root: "/tmp",
      body: Buffer.from("const x = 1;"),
      registered_via: "folder",
    });
    reg.updateClassification(out.fingerprint, {
      classifier_bucket: "sourcecode",
      has_yaml_frontmatter: 0,
      detected_language: "typescript",
      detected_format: "sourcecode",
    });
    const row = reg.getByFingerprint(out.fingerprint)!;
    expect(row.classifier_bucket).toBe("sourcecode");
    expect(row.has_yaml_frontmatter).toBe(0);
    expect(row.detected_language).toBe("typescript");
    expect(row.detected_format).toBe("sourcecode");
  });

  it("accepts partial fields (omitted ones become null)", () => {
    /** Optional fields are allowed to be absent at write time. */
    const out = reg.registerFile({
      file_path: "/tmp/x",
      source_root: "/tmp",
      body: Buffer.from("hi"),
      registered_via: "folder",
    });
    reg.updateClassification(out.fingerprint, {
      classifier_bucket: "binary",
    });
    const row = reg.getByFingerprint(out.fingerprint)!;
    expect(row.classifier_bucket).toBe("binary");
    expect(row.has_yaml_frontmatter).toBeNull();
    expect(row.detected_language).toBeNull();
    expect(row.detected_format).toBeNull();
  });
});

// ── lookups + listing ──────────────────────────────────────────────────

describe("lookups", () => {
  it("findByShortId / findByPath return the same row as findByFingerprint", () => {
    /** All three should resolve to the same identity. */
    const out = reg.registerFile({
      file_path: "/tmp/x.ts",
      source_root: "/tmp",
      body: Buffer.from("hi"),
      registered_via: "folder",
    });
    const a = reg.getByFingerprint(out.fingerprint)!;
    const b = reg.getByShortId(out.short_id)!;
    const c = reg.getByPath("/tmp/x.ts")!;
    expect(a.short_id).toBe(b.short_id);
    expect(a.short_id).toBe(c.short_id);
  });
});

describe("listEligible", () => {
  beforeEach(() => {
    reg.registerFile({
      file_path: "/tmp/a.ts",
      source_root: "/tmp",
      body: Buffer.from("a"),
      registered_via: "folder",
    });
    reg.registerFile({
      file_path: "/tmp/b.ts",
      source_root: "/tmp",
      body: Buffer.from("b"),
      registered_via: "folder",
    });
    reg.registerFile({
      file_path: "/tmp/c.md",
      source_root: "/tmp",
      body: Buffer.from("c"),
      registered_via: "folder",
    });
  });

  it("lists every row when no bucket is given", () => {
    /** Default scout flow grabs everything in the registry. */
    expect(reg.listEligible()).toHaveLength(3);
  });

  it("filters by bucket", () => {
    /** Per-bucket scouts let the user route by classifier output. */
    const a = reg.getByPath("/tmp/a.ts")!;
    const b = reg.getByPath("/tmp/b.ts")!;
    reg.updateClassification(a.fingerprint, { classifier_bucket: "sourcecode" });
    reg.updateClassification(b.fingerprint, { classifier_bucket: "sourcecode" });
    expect(reg.listEligible({ bucket: "sourcecode" })).toHaveLength(2);
    expect(reg.listEligible({ bucket: "documentation" })).toHaveLength(0);
  });

  it("respects limit", () => {
    /** Bound the scout's first batch when smoke-testing. */
    expect(reg.listEligible({ limit: 2 })).toHaveLength(2);
  });
});

// ── skipped log ────────────────────────────────────────────────────────

describe("recordSkipped + listSkipped", () => {
  it("records an entry per phase and filters back by phase", () => {
    /** Q5/Q6: every skip is reported with reason; users can audit. */
    reg.recordSkipped({
      file_path: "/tmp/big.bin",
      reason: "size > 50% context",
      phase: "register",
      size_bytes: 999_999,
      context_pct: 0.6,
    });
    reg.recordSkipped({
      file_path: "/tmp/medium.txt",
      reason: "size > 40% context",
      phase: "scout",
      size_bytes: 500_000,
      context_pct: 0.45,
    });
    expect(reg.listSkipped("register")).toHaveLength(1);
    expect(reg.listSkipped("scout")).toHaveLength(1);
    expect(reg.listSkipped()).toHaveLength(2);
  });
});

// ── stats ──────────────────────────────────────────────────────────────

describe("countFiles + countByBucket", () => {
  it("countByBucket returns one entry per distinct bucket", () => {
    /** Used by estimate to print a per-bucket breakdown. */
    reg.registerFiles([
      {
        file_path: "/tmp/1",
        source_root: "/tmp",
        body: Buffer.from("a"),
        registered_via: "folder",
      },
      {
        file_path: "/tmp/2",
        source_root: "/tmp",
        body: Buffer.from("b"),
        registered_via: "folder",
      },
      {
        file_path: "/tmp/3",
        source_root: "/tmp",
        body: Buffer.from("c"),
        registered_via: "folder",
      },
    ]);
    const a = reg.getByPath("/tmp/1")!;
    reg.updateClassification(a.fingerprint, { classifier_bucket: "sourcecode" });
    const buckets = reg.countByBucket();
    expect(buckets.sourcecode).toBe(1);
    expect(buckets.unknown).toBe(2);
  });
});

// ── fingerprintOf ──────────────────────────────────────────────────────

describe("Registry.fingerprintOf", () => {
  it("is stable across calls", () => {
    /** Same input → same output, deterministic. */
    const a = Registry.fingerprintOf(Buffer.from("hello"));
    const b = Registry.fingerprintOf(Buffer.from("hello"));
    expect(a).toBe(b);
  });

  it("changes if any byte changes", () => {
    /** A single bit-flip must produce a different fingerprint. */
    const a = Registry.fingerprintOf(Buffer.from("hello"));
    const b = Registry.fingerprintOf(Buffer.from("hellp"));
    expect(a).not.toBe(b);
  });

  it("is 40 hex chars (sha1)", () => {
    /** Schema column is TEXT; downstream callers can rely on the shape. */
    const fp = Registry.fingerprintOf(Buffer.from(""));
    expect(fp).toMatch(/^[a-f0-9]{40}$/);
  });
});

// ── v2 — jobs ──────────────────────────────────────────────────────────

/** Helper: build a syntactically-valid JobInput for tests. */
function makeJobInput(jobId = "scout-test-1"): {
  job_id: string;
  fieldset_name: string;
  fieldset_json: string;
  json_schema: string;
  model: string;
  workers: number;
  source_root: string;
  notes?: string;
} {
  return {
    job_id: jobId,
    fieldset_name: "ts-code-audit",
    fieldset_json: JSON.stringify({ version: 1, fields: [] }),
    json_schema: JSON.stringify({ type: "object", required: [] }),
    model: "qwen/qwen-2.5-7b-instruct",
    workers: 16,
    source_root: "/tmp/x",
    notes: "smoke test",
  };
}

describe("createJob / getJob", () => {
  it("inserts a job row and round-trips every column", () => {
    /** All caller-supplied fields must be readable back unchanged. */
    const input = makeJobInput();
    const created = reg.createJob(input);
    expect(created.job_id).toBe(input.job_id);
    expect(created.fieldset_name).toBe(input.fieldset_name);
    expect(created.fieldset_json).toBe(input.fieldset_json);
    expect(created.json_schema).toBe(input.json_schema);
    expect(created.model).toBe(input.model);
    expect(created.workers).toBe(input.workers);
    expect(created.source_root).toBe(input.source_root);
    expect(created.notes).toBe(input.notes);
    expect(created.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(created.ended_at).toBeNull();
    expect(created.cost_usd).toBeNull();

    const fetched = reg.getJob(input.job_id)!;
    expect(fetched).toEqual(created);
  });

  it("getJob returns null for unknown ids", () => {
    /** Caller distinguishes 'not started' vs 'failed'. */
    expect(reg.getJob("nope")).toBeNull();
  });

  it("createJob rejects duplicate job_id (PK conflict)", () => {
    /** Caller is responsible for unique ids; collision is a logic bug. */
    reg.createJob(makeJobInput("dup-1"));
    expect(() => reg.createJob(makeJobInput("dup-1"))).toThrow();
  });

  it("listJobs orders by started_at DESC (newest first)", () => {
    /** UI/log defaults to newest job. We sleep 5ms so timestamps differ. */
    reg.createJob(makeJobInput("a"));
    // Force a different ISO timestamp by introducing a small delay.
    const start = Date.now();
    while (Date.now() - start < 6) {
      // spin briefly — vitest's fake timers stay off here
    }
    reg.createJob(makeJobInput("b"));
    const rows = reg.listJobs();
    expect(rows.map((r) => r.job_id)).toEqual(["b", "a"]);
  });
});

describe("updateJobProgress / finalizeJob", () => {
  it("updateJobProgress patches only the supplied fields (COALESCE)", () => {
    /** Token-frugal: caller doesn't have to re-send the whole row. */
    reg.createJob(makeJobInput("u-1"));
    reg.updateJobProgress("u-1", {
      files_total: 100,
      files_ok: 50,
      cost_usd: 0.01,
    });
    let job = reg.getJob("u-1")!;
    expect(job.files_total).toBe(100);
    expect(job.files_ok).toBe(50);
    expect(job.cost_usd).toBeCloseTo(0.01);
    expect(job.files_failed).toBeNull();

    // Now patch only files_failed; prior fields must stay.
    reg.updateJobProgress("u-1", { files_failed: 3 });
    job = reg.getJob("u-1")!;
    expect(job.files_total).toBe(100);
    expect(job.files_ok).toBe(50);
    expect(job.files_failed).toBe(3);
  });

  it("finalizeJob sets ended_at to now() and accepts final progress", () => {
    /** Used by the scout layer to mark the run done in one statement. */
    reg.createJob(makeJobInput("f-1"));
    reg.finalizeJob("f-1", {
      files_total: 7,
      files_ok: 6,
      files_failed: 1,
      retries: 2,
      cost_usd: 0.0123,
    });
    const job = reg.getJob("f-1")!;
    expect(job.ended_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(job.files_total).toBe(7);
    expect(job.files_ok).toBe(6);
    expect(job.files_failed).toBe(1);
    expect(job.retries).toBe(2);
    expect(job.cost_usd).toBeCloseTo(0.0123);
  });
});

// ── v2 — results ───────────────────────────────────────────────────────

/** Register a file and return its short_id + fingerprint. */
function seedFile(path = "/tmp/seed.ts", body = "export const x = 1\n"): {
  short_id: number;
  fingerprint: string;
} {
  const out = reg.registerFile({
    file_path: path,
    source_root: "/tmp",
    body: Buffer.from(body),
    registered_via: "folder",
  });
  return { short_id: out.short_id, fingerprint: out.fingerprint };
}

describe("insertResult / getResult", () => {
  it("inserts to results AND fts5 in one transaction", () => {
    /** Every result row must have a paired FTS row keyed by (job, fp). */
    reg.createJob(makeJobInput("r-1"));
    const f = seedFile();
    reg.insertResult({
      job_id: "r-1",
      file_fingerprint: f.fingerprint,
      short_id: f.short_id,
      result_json: JSON.stringify({ is_async: true, framework: "vite" }),
      raw_response: "{...}",
      repaired: 0,
      attempts: 1,
      cost_usd: 0.000_005,
      searchable_text: "vite async build tool",
    });
    const got = reg.getResult("r-1", f.fingerprint)!;
    expect(got.result_json).toContain('"is_async":true');
    expect(got.attempts).toBe(1);
    expect(got.repaired).toBe(0);
    expect(got.cost_usd).toBeCloseTo(0.000_005);
    expect(got.enriched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const ftsCount = reg.db
      .prepare(
        "SELECT COUNT(*) AS n FROM mass_scout_results_fts WHERE job_id = ? AND file_fingerprint = ?",
      )
      .get("r-1", f.fingerprint) as { n: number };
    expect(ftsCount.n).toBe(1);
  });

  it("getResult returns null for unknown (job,fingerprint)", () => {
    /** Resume code uses this to skip already-done files. */
    expect(reg.getResult("missing", "deadbeef".repeat(5))).toBeNull();
  });

  it("listResultsByJob honours limit + offset", () => {
    /** Pagination for the export tool. */
    reg.createJob(makeJobInput("l-1"));
    const fps: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = seedFile(`/tmp/f${i}.ts`, `body-${i}`);
      fps.push(f.fingerprint);
      reg.insertResult({
        job_id: "l-1",
        file_fingerprint: f.fingerprint,
        short_id: f.short_id,
        result_json: JSON.stringify({ i }),
        searchable_text: `row ${i}`,
      });
    }
    expect(reg.listResultsByJob("l-1", { limit: 2 }).length).toBe(2);
    expect(reg.listResultsByJob("l-1", { limit: 2, offset: 4 }).length).toBe(1);
    expect(reg.countResultsByJob("l-1")).toBe(5);
  });

  it("existingFingerprintsForJob returns the set of done files", () => {
    /** Resume key: (eligible) - (done) = todo. */
    reg.createJob(makeJobInput("e-1"));
    const a = seedFile("/tmp/a.ts", "aaa");
    const b = seedFile("/tmp/b.ts", "bbb");
    reg.insertResult({
      job_id: "e-1",
      file_fingerprint: a.fingerprint,
      short_id: a.short_id,
      result_json: "{}",
      searchable_text: "",
    });
    const done = reg.existingFingerprintsForJob("e-1");
    expect(done.has(a.fingerprint)).toBe(true);
    expect(done.has(b.fingerprint)).toBe(false);
    expect(done.size).toBe(1);
  });
});

describe("deleteJobCascade", () => {
  it("removes job, results, and fts rows in one go", () => {
    /** Used by clean-resume + tests. */
    reg.createJob(makeJobInput("d-1"));
    const f = seedFile();
    reg.insertResult({
      job_id: "d-1",
      file_fingerprint: f.fingerprint,
      short_id: f.short_id,
      result_json: "{}",
      searchable_text: "anything",
    });
    reg.deleteJobCascade("d-1");
    expect(reg.getJob("d-1")).toBeNull();
    expect(reg.countResultsByJob("d-1")).toBe(0);
    const fts = reg.db
      .prepare(
        "SELECT COUNT(*) AS n FROM mass_scout_results_fts WHERE job_id = ?",
      )
      .get("d-1") as { n: number };
    expect(fts.n).toBe(0);
  });
});

// ── v2 — search ────────────────────────────────────────────────────────

describe("searchFtsByJob", () => {
  beforeEach(() => {
    reg.createJob(makeJobInput("s-1"));
    const seed = (path: string, body: string, text: string): void => {
      const f = seedFile(path, body);
      reg.insertResult({
        job_id: "s-1",
        file_fingerprint: f.fingerprint,
        short_id: f.short_id,
        result_json: JSON.stringify({ text }),
        searchable_text: text,
      });
    };
    seed("/tmp/a.md", "a", "react hooks tutorial useEffect");
    seed("/tmp/b.md", "b", "vue composition api ref watch");
    seed("/tmp/c.md", "c", "react components state management");
  });

  it("matches FTS5 keywords across rows", () => {
    /** Two of three rows mention "react" — both must come back. */
    const hits = reg.searchFtsByJob("s-1", "react");
    expect(hits.length).toBe(2);
    for (const h of hits) {
      expect(h.snippet).toMatch(/\[react\]/i);
    }
  });

  it("supports FTS5 boolean operators", () => {
    /** "react AND state" → row C only. */
    const hits = reg.searchFtsByJob("s-1", "react AND state");
    expect(hits.length).toBe(1);
    expect(hits[0]?.snippet).toMatch(/state/i);
  });

  it("honours the limit parameter", () => {
    /** Caller paginates by walking a sorted ranking. */
    const hits = reg.searchFtsByJob("s-1", "react", 1);
    expect(hits.length).toBe(1);
  });

  it("returns no hits for unmatched terms", () => {
    /** No rows mention "kotlin" — clean empty array, not error. */
    expect(reg.searchFtsByJob("s-1", "kotlin")).toEqual([]);
  });
});

describe("searchByJsonExtract", () => {
  beforeEach(() => {
    reg.createJob(makeJobInput("j-1"));
    const seed = (path: string, body: string, json: object): void => {
      const f = seedFile(path, body);
      reg.insertResult({
        job_id: "j-1",
        file_fingerprint: f.fingerprint,
        short_id: f.short_id,
        result_json: JSON.stringify(json),
        searchable_text: "",
      });
    };
    seed("/tmp/a", "a", { is_async: true, complexity: 3 });
    seed("/tmp/b", "b", { is_async: false, complexity: 8 });
    seed("/tmp/c", "c", { is_async: true, complexity: 5 });
  });

  it("matches boolean equality via json_extract", () => {
    /** SQLite stores SQL booleans as 0/1 — JSON booleans become same in extract. */
    const hits = reg.searchByJsonExtract("j-1", "$.is_async", "=", 1);
    expect(hits.length).toBe(2);
  });

  it("matches numeric ranges", () => {
    /** Range filters are the simplest non-equality predicate. */
    expect(reg.searchByJsonExtract("j-1", "$.complexity", ">=", 5).length).toBe(
      2,
    );
    expect(reg.searchByJsonExtract("j-1", "$.complexity", "<", 5).length).toBe(
      1,
    );
  });

  it("rejects malformed JSON paths", () => {
    /** The path is interpolated — strict allowlist prevents SQL injection. */
    expect(() =>
      reg.searchByJsonExtract("j-1", "DROP TABLE", "=", 1),
    ).toThrow(/invalid JSON path/);
    expect(() =>
      reg.searchByJsonExtract("j-1", "$.foo;DROP", "=", 1),
    ).toThrow(/invalid JSON path/);
  });

  it("rejects unsupported operators", () => {
    /** Operators are interpolated; allowlist must catch every other token. */
    type AnyOp = Parameters<Registry["searchByJsonExtract"]>[2];
    expect(() =>
      reg.searchByJsonExtract("j-1", "$.is_async", "OR" as unknown as AnyOp, 1),
    ).toThrow(/unsupported op/);
  });
});
