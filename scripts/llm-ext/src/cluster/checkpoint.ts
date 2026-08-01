// SQLite-backed checkpoint for cluster_synonyms runs. Mirrors the
// union-find edges and the LLM-call history to disk so a run can resume
// after an abort, a budget exhaustion, or a process restart. WAL mode
// gives crash-consistent transactions without the rename dance.
//
// Schema (per §3 of TRDD-220ea89f):
//   clusters_uf(item_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL)
//   llm_calls(call_id TEXT PRIMARY KEY, phase INTEGER, batch_hash TEXT,
//             response_path TEXT, status TEXT, ts INTEGER)
//   meta(key TEXT PRIMARY KEY, value TEXT)

import Database from "better-sqlite3";
import { UnionFind } from "./unionfind.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export interface LlmCallRecord {
  call_id: string;
  phase: 1 | 2 | 3;
  batch_hash: string;
  response_path: string | null;
  status: "ok" | "retry" | "failed" | "skipped";
  ts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clusters_uf (
  item_id   TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_calls (
  call_id       TEXT PRIMARY KEY,
  phase         INTEGER NOT NULL,
  batch_hash    TEXT,
  response_path TEXT,
  status        TEXT NOT NULL,
  ts            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE INDEX IF NOT EXISTS llm_calls_phase_ts ON llm_calls(phase, ts);
CREATE INDEX IF NOT EXISTS llm_calls_batch_hash ON llm_calls(batch_hash);
`;

export class CheckpointDB {
  private db: Database.Database;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static open(path: string): CheckpointDB {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(SCHEMA);
    return new CheckpointDB(db);
  }

  close(): void {
    this.db.close();
  }

  // ── union-find persistence ────────────────────────────────────────

  /**
   * Atomically replace the entire clusters_uf table with the current
   * UnionFind state. Wrapped in a single transaction so partial writes
   * cannot corrupt the snapshot on crash.
   */
  saveUnionFind(uf: UnionFind): void {
    const edges = uf.edges();
    const replace = this.db.transaction((rows: Array<[string, string]>) => {
      this.db.exec("DELETE FROM clusters_uf");
      const stmt = this.db.prepare(
        "INSERT INTO clusters_uf(item_id, parent_id) VALUES (?, ?)",
      );
      for (const [a, b] of rows) stmt.run(a, b);
    });
    replace(edges);
  }

  /**
   * Rehydrate a UnionFind from the persisted edges. Returns an empty
   * UnionFind if the table is empty.
   */
  loadUnionFind(): UnionFind {
    const rows = this.db
      .prepare("SELECT item_id, parent_id FROM clusters_uf")
      .all() as Array<{ item_id: string; parent_id: string }>;
    return UnionFind.fromEdges(rows.map((r) => [r.item_id, r.parent_id]));
  }

  // ── LLM call history ──────────────────────────────────────────────

  recordCall(rec: LlmCallRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO llm_calls
         (call_id, phase, batch_hash, response_path, status, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.call_id, rec.phase, rec.batch_hash, rec.response_path, rec.status, rec.ts);
  }

  /**
   * All call rows for a given phase, ordered by timestamp. Used by the
   * resume path to skip already-completed batches.
   */
  callsForPhase(phase: 1 | 2 | 3): LlmCallRecord[] {
    const rows = this.db
      .prepare(
        `SELECT call_id, phase, batch_hash, response_path, status, ts
         FROM llm_calls WHERE phase = ? ORDER BY ts ASC`,
      )
      .all(phase) as LlmCallRecord[];
    return rows;
  }

  countCalls(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM llm_calls")
      .get() as { n: number };
    return row.n;
  }

  /**
   * True iff a row with this batch_hash already exists with status "ok".
   * Used to skip a batch on resume that has already been satisfied.
   */
  hasCompletedBatch(batchHash: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM llm_calls WHERE batch_hash = ? AND status = 'ok' LIMIT 1",
      )
      .get(batchHash) as { 1: number } | undefined;
    return row !== undefined;
  }

  // ── run-level metadata ────────────────────────────────────────────

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  allMeta(): Record<string, string> {
    const rows = this.db
      .prepare("SELECT key, value FROM meta")
      .all() as Array<{ key: string; value: string }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }
}
