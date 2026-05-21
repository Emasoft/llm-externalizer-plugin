// Unit tests for checkpoint.ts. Exercises SQLite-backed persistence of
// the union-find edges and the LLM-call history. No external network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CheckpointDB } from "./checkpoint.js";
import { UnionFind } from "./unionfind.js";

describe("CheckpointDB", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cluster-ckpt-"));
    dbPath = join(dir, "checkpoint.sqlite");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the schema on open()", () => {
    const db = CheckpointDB.open(dbPath);
    db.close();
    // Re-opening should work (idempotent CREATE IF NOT EXISTS).
    const db2 = CheckpointDB.open(dbPath);
    expect(db2.countCalls()).toBe(0);
    db2.close();
  });

  it("persists and rehydrates a UnionFind", () => {
    const uf = new UnionFind();
    for (const id of ["a", "b", "c", "d", "e"]) uf.add(id);
    uf.union("a", "b");
    uf.union("c", "d");
    uf.union("d", "e");
    // Resulting partition: {a,b} size 2, {c,d,e} size 3.

    const db = CheckpointDB.open(dbPath);
    db.saveUnionFind(uf);
    db.close();

    const db2 = CheckpointDB.open(dbPath);
    const restored = db2.loadUnionFind();
    expect(restored.numClusters()).toBe(uf.numClusters());
    const part = restored.partition();
    const sizes = Array.from(part.values()).map((v) => v.length).sort();
    expect(sizes).toEqual([2, 3]);
    db2.close();
  });

  it("overwrites the prior UnionFind atomically on every save", () => {
    const db = CheckpointDB.open(dbPath);
    const uf1 = new UnionFind();
    uf1.add("a"); uf1.add("b"); uf1.union("a", "b");
    db.saveUnionFind(uf1);

    const uf2 = new UnionFind();
    uf2.add("c"); uf2.add("d");
    db.saveUnionFind(uf2);

    const restored = db.loadUnionFind();
    expect(restored.numClusters()).toBe(2);
    // The previous {a,b} cluster must NOT be present after replace.
    expect(restored.has("a")).toBe(false);
    expect(restored.has("c")).toBe(true);
    db.close();
  });

  it("records and retrieves LLM call history per phase", () => {
    const db = CheckpointDB.open(dbPath);
    db.recordCall({
      call_id: "c1", phase: 1, batch_hash: "h1",
      response_path: "/tmp/r1.json", status: "ok", ts: 1000,
    });
    db.recordCall({
      call_id: "c2", phase: 1, batch_hash: "h2",
      response_path: "/tmp/r2.json", status: "ok", ts: 2000,
    });
    db.recordCall({
      call_id: "c3", phase: 2, batch_hash: "h3",
      response_path: null, status: "failed", ts: 3000,
    });

    const phase1 = db.callsForPhase(1);
    expect(phase1).toHaveLength(2);
    expect(phase1[0].call_id).toBe("c1");

    const phase2 = db.callsForPhase(2);
    expect(phase2).toHaveLength(1);
    expect(phase2[0].status).toBe("failed");

    expect(db.countCalls()).toBe(3);
    db.close();
  });

  it("hasCompletedBatch() returns true only for status='ok' rows", () => {
    const db = CheckpointDB.open(dbPath);
    db.recordCall({
      call_id: "c1", phase: 1, batch_hash: "h1",
      response_path: null, status: "failed", ts: 1,
    });
    db.recordCall({
      call_id: "c2", phase: 1, batch_hash: "h2",
      response_path: "/tmp/r.json", status: "ok", ts: 2,
    });
    expect(db.hasCompletedBatch("h1")).toBe(false);
    expect(db.hasCompletedBatch("h2")).toBe(true);
    expect(db.hasCompletedBatch("h-missing")).toBe(false);
    db.close();
  });

  it("upserts metadata", () => {
    const db = CheckpointDB.open(dbPath);
    db.setMeta("input_hash", "abc");
    expect(db.getMeta("input_hash")).toBe("abc");
    db.setMeta("input_hash", "def");
    expect(db.getMeta("input_hash")).toBe("def");
    db.setMeta("policy_hash", "xyz");
    expect(db.allMeta()).toEqual({ input_hash: "def", policy_hash: "xyz" });
    db.close();
  });

  it("returns undefined for missing metadata", () => {
    const db = CheckpointDB.open(dbPath);
    expect(db.getMeta("nope")).toBeUndefined();
    db.close();
  });
});
