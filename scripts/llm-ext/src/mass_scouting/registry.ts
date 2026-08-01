/**
 * mass-scouting persistent registry — file_short_id, body cache, skipped log,
 * jobs / results / FTS5 surface for the scout phase.
 *
 * SQLite via better-sqlite3 (synchronous, WAL-mode). Schema is forward-only
 * via versioned migrations; v1 = file/body/skipped, v2 = scout jobs+results.
 *
 * Token-frugality directive (TRDD §15): file bodies are read from disk ONCE at
 * register time and cached as BLOBs in `file_body_cache`. Every downstream
 * phase (preclassify, scout, sample, regex search) reads from the cache, never
 * the disk.
 *
 * FTS5 design note (blueprint pitfall #2): the FTS table is *standalone*, not
 * `content=mass_scout_results`. Linked-content tables crash on schema change;
 * standalone is durable across migrations and easy to rebuild.
 */

import Database from "better-sqlite3";
import type { Database as SqliteDatabase, Statement } from "better-sqlite3";
import { createHash } from "node:crypto";
import { basename } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface OpenRegistryOptions {
  /** Path to the SQLite file. ":memory:" for in-memory. */
  path: string;
  /** Apply WAL pragmas. Default true. */
  walMode?: boolean;
}

export interface RegisterFileInput {
  /** Absolute path on disk (the canonical identity). */
  file_path: string;
  /** The folder root the caller derived this file from (for grouping). */
  source_root: string;
  /** Raw file bytes. Used for fingerprint AND body cache. Read once. */
  body: Buffer;
  /** "folder" = walked from a directory, "explicit" = caller passed the path. */
  registered_via: "folder" | "explicit";
}

export interface RegisterFileResult {
  short_id: number;
  fingerprint: string;
  /** True when this file was already in the registry (by content fingerprint). */
  already_registered: boolean;
}

export interface ClassifierFields {
  classifier_bucket: string;
  has_yaml_frontmatter?: 0 | 1;
  detected_language?: string | null;
  detected_format?: string | null;
}

export interface RegistryRow {
  short_id: number;
  fingerprint: string;
  file_path: string;
  source_root: string;
  basename: string;
  classifier_bucket: string;
  has_yaml_frontmatter: number | null;
  detected_language: string | null;
  detected_format: string | null;
  file_size_bytes: number;
  registered_via: "folder" | "explicit";
  created_at: string;
}

export interface SkippedInput {
  short_id?: number | null;
  file_path: string;
  reason: string;
  /** "register" | "scout" | "sample" — the phase that decided to skip. */
  phase: "register" | "scout" | "sample" | "preclassify";
  size_bytes?: number | null;
  context_pct?: number | null;
}

export interface SkippedRow extends SkippedInput {
  recorded_at: string;
}

// ── Scout job / result types ───────────────────────────────────────────

export interface JobInput {
  /** Stable ID — caller decides (typically `scout-<ts>-<slug>`). */
  job_id: string;
  fieldset_name: string;
  /** Validated ScoutFieldset, JSON-serialised. */
  fieldset_json: string;
  /** Compiled JSON Schema, JSON-serialised. */
  json_schema: string;
  model: string;
  workers: number;
  source_root: string;
  /** Optional preclassifier bucket filter (e.g. "documentation"). */
  bucket_filter?: string | null;
  notes?: string | null;
}

export interface JobRow extends JobInput {
  started_at: string;
  ended_at: string | null;
  files_total: number | null;
  files_ok: number | null;
  files_failed: number | null;
  retries: number | null;
  cost_usd: number | null;
}

export interface JobProgress {
  files_total?: number;
  files_ok?: number;
  files_failed?: number;
  retries?: number;
  cost_usd?: number;
}

export interface ResultInput {
  job_id: string;
  file_fingerprint: string;
  short_id: number;
  /** Stringified JSON of the validated extraction (per the dynamic schema). */
  result_json: string;
  /** Pre-repair raw model response, for audit. May be null on synthetic rows. */
  raw_response?: string | null;
  /** 1 if fix_envelope had to repair the raw response, else 0. */
  repaired?: 0 | 1;
  /** Number of LLM calls made for this file (1 = first try succeeded). */
  attempts?: number;
  cost_usd?: number;
  /**
   * Concatenation of every string / array_string / enum field value, used to
   * feed the FTS5 index. Built by the scout layer using the compiled fieldset.
   */
  searchable_text: string;
}

export interface ResultRow {
  job_id: string;
  file_fingerprint: string;
  short_id: number;
  result_json: string;
  raw_response: string | null;
  repaired: number;
  attempts: number;
  cost_usd: number | null;
  enriched_at: string;
}

export interface FtsHit {
  short_id: number;
  file_fingerprint: string;
  /** SQLite FTS5 bm25 — lower is better. */
  rank: number;
  /** The matched `searchable_text` snippet (auto-highlighted by snippet()). */
  snippet: string;
}

// ── Migrations ─────────────────────────────────────────────────────────

const SCHEMA_VERSION = 2;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS file_short_id (
        short_id              INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint           TEXT NOT NULL UNIQUE,
        file_path             TEXT NOT NULL,
        source_root           TEXT NOT NULL,
        basename              TEXT NOT NULL,
        classifier_bucket     TEXT NOT NULL DEFAULT 'unknown',
        has_yaml_frontmatter  INTEGER,
        detected_language     TEXT,
        detected_format       TEXT,
        file_size_bytes       INTEGER NOT NULL,
        registered_via        TEXT NOT NULL CHECK(registered_via IN ('folder','explicit')),
        created_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_fsi_path   ON file_short_id(file_path);
      CREATE INDEX IF NOT EXISTS idx_fsi_bucket ON file_short_id(classifier_bucket);

      CREATE TABLE IF NOT EXISTS file_body_cache (
        fingerprint  TEXT PRIMARY KEY,
        body         BLOB NOT NULL,
        body_bytes   INTEGER NOT NULL,
        cached_at    TEXT NOT NULL,
        FOREIGN KEY (fingerprint) REFERENCES file_short_id(fingerprint)
      );

      CREATE TABLE IF NOT EXISTS mass_scout_skipped (
        rowid         INTEGER PRIMARY KEY AUTOINCREMENT,
        short_id      INTEGER,
        file_path     TEXT NOT NULL,
        reason        TEXT NOT NULL,
        phase         TEXT NOT NULL CHECK(phase IN ('register','preclassify','scout','sample')),
        size_bytes    INTEGER,
        context_pct   REAL,
        recorded_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_skipped_phase ON mass_scout_skipped(phase);
      CREATE INDEX IF NOT EXISTS idx_skipped_path  ON mass_scout_skipped(file_path);

      CREATE TABLE IF NOT EXISTS schema_version (
        version    INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS mass_scout_jobs (
        job_id          TEXT PRIMARY KEY,
        fieldset_name   TEXT NOT NULL,
        fieldset_json   TEXT NOT NULL,
        json_schema     TEXT NOT NULL,
        model           TEXT NOT NULL,
        workers         INTEGER NOT NULL,
        source_root     TEXT NOT NULL,
        bucket_filter   TEXT,
        started_at      TEXT NOT NULL,
        ended_at        TEXT,
        files_total     INTEGER,
        files_ok        INTEGER,
        files_failed    INTEGER,
        retries         INTEGER,
        cost_usd        REAL,
        notes           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_started ON mass_scout_jobs(started_at);

      CREATE TABLE IF NOT EXISTS mass_scout_results (
        job_id            TEXT NOT NULL,
        file_fingerprint  TEXT NOT NULL,
        short_id          INTEGER NOT NULL,
        result_json       TEXT NOT NULL,
        raw_response      TEXT,
        repaired          INTEGER NOT NULL DEFAULT 0,
        attempts          INTEGER NOT NULL DEFAULT 1,
        cost_usd          REAL,
        enriched_at       TEXT NOT NULL,
        PRIMARY KEY (job_id, file_fingerprint),
        FOREIGN KEY (short_id) REFERENCES file_short_id(short_id),
        FOREIGN KEY (job_id)   REFERENCES mass_scout_jobs(job_id)
      );
      CREATE INDEX IF NOT EXISTS idx_results_short ON mass_scout_results(short_id);
      CREATE INDEX IF NOT EXISTS idx_results_job   ON mass_scout_results(job_id);

      -- Standalone FTS5 (blueprint pitfall #2 — never use content= link).
      CREATE VIRTUAL TABLE IF NOT EXISTS mass_scout_results_fts USING fts5(
        job_id           UNINDEXED,
        file_fingerprint UNINDEXED,
        short_id         UNINDEXED,
        searchable_text,
        tokenize='porter unicode61'
      );
    `,
  },
];

function applyMigrations(db: SqliteDatabase): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const row = db
    .prepare("SELECT MAX(version) AS v FROM schema_version")
    .get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
      ).run(m.version, new Date().toISOString());
    });
    tx();
  }
}

// ── Registry handle ────────────────────────────────────────────────────

/**
 * Thin wrapper bundling a better-sqlite3 Database with prepared statements.
 * Cheap to construct but you must call close() to release the file handle.
 */
export class Registry {
  readonly db: SqliteDatabase;

  // Prepared statements (cached for performance)
  private readonly stmt: {
    insertFile: Statement;
    findByFingerprint: Statement;
    findByShortId: Statement;
    findByPath: Statement;
    listEligible: Statement;
    listEligibleBucket: Statement;
    updateClassification: Statement;
    insertBody: Statement;
    selectBody: Statement;
    deleteBody: Statement;
    insertSkipped: Statement;
    listSkipped: Statement;
    listSkippedAll: Statement;
    countFiles: Statement;
    countByBucket: Statement;
    // v2 — jobs
    insertJob: Statement;
    selectJob: Statement;
    listJobs: Statement;
    updateJobProgress: Statement;
    finalizeJob: Statement;
    deleteJob: Statement;
    // v2 — results
    insertResult: Statement;
    selectResult: Statement;
    listResultsByJob: Statement;
    countResultsByJob: Statement;
    existingFingerprintsForJob: Statement;
    deleteResultsByJob: Statement;
    // v2 — fts5
    insertFts: Statement;
    deleteFtsByJob: Statement;
    searchFtsByJob: Statement;
  };

  constructor(db: SqliteDatabase) {
    this.db = db;
    this.stmt = {
      insertFile: db.prepare(
        `INSERT INTO file_short_id
         (fingerprint, file_path, source_root, basename, file_size_bytes, registered_via, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      findByFingerprint: db.prepare(
        "SELECT * FROM file_short_id WHERE fingerprint = ?",
      ),
      findByShortId: db.prepare(
        "SELECT * FROM file_short_id WHERE short_id = ?",
      ),
      findByPath: db.prepare(
        "SELECT * FROM file_short_id WHERE file_path = ?",
      ),
      listEligible: db.prepare(
        "SELECT * FROM file_short_id ORDER BY short_id LIMIT ?",
      ),
      listEligibleBucket: db.prepare(
        "SELECT * FROM file_short_id WHERE classifier_bucket = ? ORDER BY short_id LIMIT ?",
      ),
      updateClassification: db.prepare(
        `UPDATE file_short_id SET
           classifier_bucket    = ?,
           has_yaml_frontmatter = ?,
           detected_language    = ?,
           detected_format      = ?
         WHERE fingerprint = ?`,
      ),
      insertBody: db.prepare(
        "INSERT OR REPLACE INTO file_body_cache (fingerprint, body, body_bytes, cached_at) VALUES (?, ?, ?, ?)",
      ),
      selectBody: db.prepare(
        "SELECT body FROM file_body_cache WHERE fingerprint = ?",
      ),
      deleteBody: db.prepare(
        "DELETE FROM file_body_cache WHERE fingerprint = ?",
      ),
      insertSkipped: db.prepare(
        `INSERT INTO mass_scout_skipped
         (short_id, file_path, reason, phase, size_bytes, context_pct, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      listSkipped: db.prepare(
        "SELECT * FROM mass_scout_skipped WHERE phase = ? ORDER BY rowid",
      ),
      listSkippedAll: db.prepare(
        "SELECT * FROM mass_scout_skipped ORDER BY rowid",
      ),
      countFiles: db.prepare("SELECT COUNT(*) AS n FROM file_short_id"),
      countByBucket: db.prepare(
        "SELECT classifier_bucket AS bucket, COUNT(*) AS n FROM file_short_id GROUP BY classifier_bucket",
      ),
      // ── v2 — jobs
      insertJob: db.prepare(
        `INSERT INTO mass_scout_jobs
         (job_id, fieldset_name, fieldset_json, json_schema, model, workers,
          source_root, bucket_filter, started_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectJob: db.prepare("SELECT * FROM mass_scout_jobs WHERE job_id = ?"),
      listJobs: db.prepare(
        "SELECT * FROM mass_scout_jobs ORDER BY started_at DESC",
      ),
      // COALESCE keeps prior values when a partial update arrives.
      updateJobProgress: db.prepare(
        `UPDATE mass_scout_jobs SET
           files_total  = COALESCE(?, files_total),
           files_ok     = COALESCE(?, files_ok),
           files_failed = COALESCE(?, files_failed),
           retries      = COALESCE(?, retries),
           cost_usd     = COALESCE(?, cost_usd)
         WHERE job_id = ?`,
      ),
      finalizeJob: db.prepare(
        `UPDATE mass_scout_jobs SET
           ended_at     = ?,
           files_total  = COALESCE(?, files_total),
           files_ok     = COALESCE(?, files_ok),
           files_failed = COALESCE(?, files_failed),
           retries      = COALESCE(?, retries),
           cost_usd     = COALESCE(?, cost_usd)
         WHERE job_id = ?`,
      ),
      deleteJob: db.prepare("DELETE FROM mass_scout_jobs WHERE job_id = ?"),
      // ── v2 — results
      insertResult: db.prepare(
        `INSERT INTO mass_scout_results
         (job_id, file_fingerprint, short_id, result_json, raw_response,
          repaired, attempts, cost_usd, enriched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      selectResult: db.prepare(
        "SELECT * FROM mass_scout_results WHERE job_id = ? AND file_fingerprint = ?",
      ),
      listResultsByJob: db.prepare(
        `SELECT * FROM mass_scout_results
         WHERE job_id = ?
         ORDER BY short_id
         LIMIT ? OFFSET ?`,
      ),
      countResultsByJob: db.prepare(
        "SELECT COUNT(*) AS n FROM mass_scout_results WHERE job_id = ?",
      ),
      existingFingerprintsForJob: db.prepare(
        "SELECT file_fingerprint FROM mass_scout_results WHERE job_id = ?",
      ),
      deleteResultsByJob: db.prepare(
        "DELETE FROM mass_scout_results WHERE job_id = ?",
      ),
      // ── v2 — fts5
      insertFts: db.prepare(
        `INSERT INTO mass_scout_results_fts
         (job_id, file_fingerprint, short_id, searchable_text)
         VALUES (?, ?, ?, ?)`,
      ),
      deleteFtsByJob: db.prepare(
        "DELETE FROM mass_scout_results_fts WHERE job_id = ?",
      ),
      // bm25 ranks lower=better; pass the FTS5 MATCH query as ?
      searchFtsByJob: db.prepare(
        `SELECT short_id, file_fingerprint, bm25(mass_scout_results_fts) AS rank,
                snippet(mass_scout_results_fts, 3, '[', ']', '…', 8) AS snippet
         FROM mass_scout_results_fts
         WHERE job_id = ? AND searchable_text MATCH ?
         ORDER BY rank
         LIMIT ?`,
      ),
    };
  }

  /** Compute SHA1 fingerprint of a body. Stable across runs. */
  static fingerprintOf(body: Buffer): string {
    return createHash("sha1").update(body).digest("hex");
  }

  /**
   * Register one file. Idempotent on (fingerprint): re-registering the same
   * content returns the existing short_id with `already_registered: true`.
   * Caches the body atomically with the registration in a transaction.
   */
  registerFile(input: RegisterFileInput): RegisterFileResult {
    const fp = Registry.fingerprintOf(input.body);
    const tx = this.db.transaction((): RegisterFileResult => {
      const existing = this.stmt.findByFingerprint.get(fp) as
        | RegistryRow
        | undefined;
      if (existing) {
        return {
          short_id: existing.short_id,
          fingerprint: fp,
          already_registered: true,
        };
      }
      const result = this.stmt.insertFile.run(
        fp,
        input.file_path,
        input.source_root,
        basename(input.file_path),
        input.body.length,
        input.registered_via,
        new Date().toISOString(),
      );
      this.stmt.insertBody.run(
        fp,
        input.body,
        input.body.length,
        new Date().toISOString(),
      );
      return {
        short_id: Number(result.lastInsertRowid),
        fingerprint: fp,
        already_registered: false,
      };
    });
    return tx();
  }

  /** Bulk register inside one transaction — much faster than N single calls. */
  registerFiles(inputs: RegisterFileInput[]): RegisterFileResult[] {
    const tx = this.db.transaction((): RegisterFileResult[] => {
      return inputs.map((i) => this.registerFile(i));
    });
    return tx();
  }

  /** Update bucket / language / format / frontmatter flag for a file. */
  updateClassification(
    fingerprint: string,
    fields: ClassifierFields,
  ): void {
    this.stmt.updateClassification.run(
      fields.classifier_bucket,
      fields.has_yaml_frontmatter ?? null,
      fields.detected_language ?? null,
      fields.detected_format ?? null,
      fingerprint,
    );
  }

  /**
   * Update ONLY the classifier_bucket column. Used by `chain` to mark a
   * subset of rows with a sentinel bucket and then restore them, without
   * disturbing has_yaml_frontmatter / detected_language / detected_format
   * (which `updateClassification` would force the caller to round-trip
   * through `0 | 1 | undefined` typing).
   */
  setClassifierBucketOnly(fingerprint: string, bucket: string): void {
    this.db
      .prepare(
        "UPDATE file_short_id SET classifier_bucket = ? WHERE fingerprint = ?",
      )
      .run(bucket, fingerprint);
  }

  getByFingerprint(fp: string): RegistryRow | null {
    return (this.stmt.findByFingerprint.get(fp) as RegistryRow | undefined) ?? null;
  }

  getByShortId(id: number): RegistryRow | null {
    return (this.stmt.findByShortId.get(id) as RegistryRow | undefined) ?? null;
  }

  getByPath(path: string): RegistryRow | null {
    return (this.stmt.findByPath.get(path) as RegistryRow | undefined) ?? null;
  }

  /** List files for the scout / preclassify phases. */
  listEligible(opts: { bucket?: string; limit?: number } = {}): RegistryRow[] {
    const limit = opts.limit ?? 1_000_000;
    if (opts.bucket !== undefined) {
      return this.stmt.listEligibleBucket.all(
        opts.bucket,
        limit,
      ) as RegistryRow[];
    }
    return this.stmt.listEligible.all(limit) as RegistryRow[];
  }

  /** Read the cached file body (single-source-of-truth — never re-read disk). */
  readBody(fp: string): Buffer | null {
    const row = this.stmt.selectBody.get(fp) as { body: Buffer } | undefined;
    return row ? row.body : null;
  }

  /** Replace or seed a body cache entry. Caller normally goes via registerFile. */
  cacheBody(fp: string, body: Buffer): void {
    this.stmt.insertBody.run(
      fp,
      body,
      body.length,
      new Date().toISOString(),
    );
  }

  /** Remove a body from the cache (e.g. after final export, to reclaim space). */
  deleteBody(fp: string): void {
    this.stmt.deleteBody.run(fp);
  }

  /** Append a skipped-file entry. */
  recordSkipped(input: SkippedInput): void {
    this.stmt.insertSkipped.run(
      input.short_id ?? null,
      input.file_path,
      input.reason,
      input.phase,
      input.size_bytes ?? null,
      input.context_pct ?? null,
      new Date().toISOString(),
    );
  }

  listSkipped(phase?: SkippedInput["phase"]): SkippedRow[] {
    if (phase) return this.stmt.listSkipped.all(phase) as SkippedRow[];
    return this.stmt.listSkippedAll.all() as SkippedRow[];
  }

  /** Quick stats helpers — used by `mass_scout_estimate` and reports. */
  countFiles(): number {
    const row = this.stmt.countFiles.get() as { n: number };
    return row.n;
  }

  countByBucket(): Record<string, number> {
    const rows = this.stmt.countByBucket.all() as {
      bucket: string;
      n: number;
    }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.bucket] = r.n;
    return out;
  }

  // ── v2 — jobs ────────────────────────────────────────────────────────

  /**
   * Create a new scout job. Throws on duplicate `job_id` (caller decides the
   * id; collisions mean a logic bug, not a recoverable state).
   */
  createJob(input: JobInput): JobRow {
    this.stmt.insertJob.run(
      input.job_id,
      input.fieldset_name,
      input.fieldset_json,
      input.json_schema,
      input.model,
      input.workers,
      input.source_root,
      input.bucket_filter ?? null,
      new Date().toISOString(),
      input.notes ?? null,
    );
    const row = this.getJob(input.job_id);
    if (!row) {
      // Should never happen — INSERT just succeeded inside the same connection.
      throw new Error(`createJob: row missing after insert (${input.job_id})`);
    }
    return row;
  }

  getJob(jobId: string): JobRow | null {
    return (this.stmt.selectJob.get(jobId) as JobRow | undefined) ?? null;
  }

  listJobs(): JobRow[] {
    return this.stmt.listJobs.all() as JobRow[];
  }

  /**
   * Pick `n` random rows from `mass_scout_results` for a given job.
   * Used by the audit sub-command for human spot-checks. Uses `ORDER BY
   * RANDOM() LIMIT n` — fine for jobs with < ~100K rows; for bigger jobs
   * caller should use offset-based pagination.
   */
  sampleResultsByJob(jobId: string, n: number): ResultRow[] {
    if (n <= 0) return [];
    return this.db
      .prepare(
        "SELECT * FROM mass_scout_results WHERE job_id = ? ORDER BY RANDOM() LIMIT ?",
      )
      .all(jobId, n) as ResultRow[];
  }

  /**
   * Look up a cached body by `short_id` (the auto-incremented integer
   * assigned at registration). The body is returned as a Buffer; callers
   * that want a string call `.toString("utf-8")`.
   */
  readBodyByShortId(shortId: number): Buffer | null {
    const row = this.db
      .prepare(
        `SELECT b.body FROM file_body_cache b
         JOIN file_short_id f ON f.fingerprint = b.fingerprint
         WHERE f.short_id = ?`,
      )
      .get(shortId) as { body: Buffer } | undefined;
    return row ? row.body : null;
  }

  /** Patch progress counters mid-run. `undefined` fields are left untouched. */
  updateJobProgress(jobId: string, patch: JobProgress): void {
    this.stmt.updateJobProgress.run(
      patch.files_total ?? null,
      patch.files_ok ?? null,
      patch.files_failed ?? null,
      patch.retries ?? null,
      patch.cost_usd ?? null,
      jobId,
    );
  }

  /** Mark a job ended_at = now() and write any final progress fields. */
  finalizeJob(jobId: string, patch: JobProgress = {}): void {
    this.stmt.finalizeJob.run(
      new Date().toISOString(),
      patch.files_total ?? null,
      patch.files_ok ?? null,
      patch.files_failed ?? null,
      patch.retries ?? null,
      patch.cost_usd ?? null,
      jobId,
    );
  }

  /**
   * Drop a job AND its results AND its FTS rows in one transaction. Useful for
   * tests, also for caller-driven `--clean-resume`.
   */
  deleteJobCascade(jobId: string): void {
    const tx = this.db.transaction(() => {
      this.stmt.deleteFtsByJob.run(jobId);
      this.stmt.deleteResultsByJob.run(jobId);
      this.stmt.deleteJob.run(jobId);
    });
    tx();
  }

  // ── v2 — results ─────────────────────────────────────────────────────

  /**
   * Insert one extraction result + its FTS row in a single transaction. Caller
   * passes pre-built `searchable_text` (concatenation of every string-typed
   * field in the result, lowercased and joined by `\n`). The dynamic-schema
   * design forces the caller to know which fields contribute, so we don't
   * compute it here.
   */
  insertResult(input: ResultInput): void {
    const tx = this.db.transaction(() => {
      this.stmt.insertResult.run(
        input.job_id,
        input.file_fingerprint,
        input.short_id,
        input.result_json,
        input.raw_response ?? null,
        input.repaired ?? 0,
        input.attempts ?? 1,
        input.cost_usd ?? null,
        new Date().toISOString(),
      );
      this.stmt.insertFts.run(
        input.job_id,
        input.file_fingerprint,
        input.short_id,
        input.searchable_text,
      );
    });
    tx();
  }

  getResult(jobId: string, fingerprint: string): ResultRow | null {
    return (
      (this.stmt.selectResult.get(jobId, fingerprint) as
        | ResultRow
        | undefined) ?? null
    );
  }

  listResultsByJob(
    jobId: string,
    opts: { limit?: number; offset?: number } = {},
  ): ResultRow[] {
    return this.stmt.listResultsByJob.all(
      jobId,
      opts.limit ?? 1_000_000,
      opts.offset ?? 0,
    ) as ResultRow[];
  }

  countResultsByJob(jobId: string): number {
    const row = this.stmt.countResultsByJob.get(jobId) as { n: number };
    return row.n;
  }

  /**
   * For `--resume`: list every fingerprint already processed for a job. Caller
   * subtracts this set from the eligible-files set to find the to-do list.
   */
  existingFingerprintsForJob(jobId: string): Set<string> {
    const rows = this.stmt.existingFingerprintsForJob.all(jobId) as {
      file_fingerprint: string;
    }[];
    return new Set(rows.map((r) => r.file_fingerprint));
  }

  // ── v2 — search ──────────────────────────────────────────────────────

  /**
   * Run an FTS5 MATCH query scoped to one job. Pass an FTS5 query string
   * (e.g. `"async AND testing"` or `"react NEAR/3 hooks"`); SQL injection is
   * not an issue because the value is bound, not interpolated, but the FTS5
   * grammar still applies.
   */
  searchFtsByJob(jobId: string, query: string, limit = 50): FtsHit[] {
    return this.stmt.searchFtsByJob.all(jobId, query, limit) as FtsHit[];
  }

  /**
   * Run a structured filter against `result_json` using SQLite's JSON1 path
   * extractor. `op` is one of `=`, `!=`, `>`, `>=`, `<`, `<=`, `LIKE`, `IN`.
   * The path is used verbatim — caller must scope it (e.g. `$.is_async`).
   *
   * SECURITY: `op` is validated against an allowlist; `path` is validated
   * against a strict regex. Values are always parameter-bound. This is the
   * only place we assemble SQL from non-bound input; without this the caller
   * couldn't run JSON1 path queries since path expressions can't be bound.
   */
  searchByJsonExtract(
    jobId: string,
    path: string,
    op: ">" | ">=" | "<" | "<=" | "=" | "!=" | "LIKE",
    value: string | number | boolean | null,
    opts: { limit?: number; offset?: number } = {},
  ): ResultRow[] {
    if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+(\[\d+\])?$/.test(path)) {
      throw new Error(
        `searchByJsonExtract: invalid JSON path ${JSON.stringify(path)}`,
      );
    }
    const ALLOWED_OPS = new Set([">", ">=", "<", "<=", "=", "!=", "LIKE"]);
    if (!ALLOWED_OPS.has(op)) {
      throw new Error(`searchByJsonExtract: unsupported op ${op}`);
    }
    // better-sqlite3 cannot bind booleans (TypeError: SQLite3 can only bind
    // numbers, strings, bigints, buffers, and null). SQLite stores JSON
    // booleans as 0/1 anyway, so coerce here so callers can pass `true`
    // / `false` naturally.
    let bound: unknown = value;
    if (typeof bound === "boolean") bound = bound ? 1 : 0;
    const sql = `SELECT * FROM mass_scout_results
                 WHERE job_id = ? AND json_extract(result_json, ?) ${op} ?
                 ORDER BY short_id LIMIT ? OFFSET ?`;
    const params: unknown[] = [
      jobId,
      path,
      bound,
      opts.limit ?? 1_000_000,
      opts.offset ?? 0,
    ];
    return this.db.prepare(sql).all(...params) as ResultRow[];
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (and migrate) a registry at the given path. Pass `:memory:` for tests.
 * The schema is forward-only; running this on an older DB applies pending
 * migrations atomically.
 */
export function openRegistry(opts: OpenRegistryOptions): Registry {
  const db = new Database(opts.path);
  if (opts.walMode !== false && opts.path !== ":memory:") {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("busy_timeout = 30000");
  }
  applyMigrations(db);
  return new Registry(db);
}

export { SCHEMA_VERSION };
