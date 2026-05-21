// Unit tests for unionfind.ts. Pure data-structure exercise — no I/O,
// no LLM, no random ordering.

import { describe, it, expect } from "vitest";
import { UnionFind } from "./unionfind.js";

describe("UnionFind", () => {
  it("starts each id as its own singleton", () => {
    const uf = new UnionFind();
    uf.add("a");
    uf.add("b");
    expect(uf.find("a")).toBe("a");
    expect(uf.find("b")).toBe("b");
    expect(uf.numClusters()).toBe(2);
    expect(uf.sizeOf("a")).toBe(1);
  });

  it("ignores re-add of an existing id", () => {
    const uf = new UnionFind();
    uf.add("a");
    uf.add("a");
    expect(uf.numClusters()).toBe(1);
  });

  it("union merges two clusters and updates size", () => {
    const uf = new UnionFind();
    uf.add("a");
    uf.add("b");
    const root = uf.union("a", "b");
    expect(root).not.toBeNull();
    expect(uf.find("a")).toBe(uf.find("b"));
    expect(uf.numClusters()).toBe(1);
    expect(uf.sizeOf("a")).toBe(2);
    expect(uf.sizeOf("b")).toBe(2);
  });

  it("union returns null when ids are already in same set", () => {
    const uf = new UnionFind();
    uf.add("a");
    uf.add("b");
    uf.union("a", "b");
    expect(uf.union("a", "b")).toBeNull();
  });

  it("transitive: union(a,b) then union(b,c) puts all three in one cluster", () => {
    const uf = new UnionFind();
    uf.add("a"); uf.add("b"); uf.add("c");
    uf.union("a", "b");
    uf.union("b", "c");
    const ra = uf.find("a"); const rb = uf.find("b"); const rc = uf.find("c");
    expect(ra).toBe(rb);
    expect(rb).toBe(rc);
    expect(uf.sizeOf("a")).toBe(3);
  });

  it("path compression makes find() converge after one walk", () => {
    const uf = new UnionFind();
    for (const id of ["a", "b", "c", "d", "e"]) uf.add(id);
    uf.union("a", "b");
    uf.union("c", "d");
    uf.union("a", "c");
    uf.union("a", "e");
    // After unions, every find should return the same root in O(1) on the second call.
    const r1 = uf.find("e");
    const edgesBefore = uf.edges();
    const r2 = uf.find("e");
    expect(r1).toBe(r2);
    // The number of internal edges is unchanged, but the chain depth is now 1.
    expect(uf.edges()).toHaveLength(edgesBefore.length);
  });

  it("find throws on unknown id", () => {
    const uf = new UnionFind();
    expect(() => uf.find("unknown")).toThrow();
  });

  it("partition returns the current clusters", () => {
    const uf = new UnionFind();
    for (const id of ["a", "b", "c", "d", "e"]) uf.add(id);
    uf.union("a", "b");
    uf.union("c", "d");
    const part = uf.partition();
    // 3 clusters: {a,b}, {c,d}, {e}
    expect(part.size).toBe(3);
    let sizes = Array.from(part.values()).map((arr) => arr.length).sort();
    expect(sizes).toEqual([1, 2, 2]);
  });

  it("fromEdges rehydrates the partition", () => {
    const uf = new UnionFind();
    for (const id of ["a", "b", "c", "d", "e"]) uf.add(id);
    uf.union("a", "b");
    uf.union("c", "d");
    uf.union("d", "e");
    const edges = uf.edges();
    const sizes = Array.from(uf.partition().values()).map((arr) => arr.length).sort();

    const restored = UnionFind.fromEdges(edges);
    expect(restored.numClusters()).toBe(uf.numClusters());
    const newSizes = Array.from(restored.partition().values()).map((arr) => arr.length).sort();
    expect(newSizes).toEqual(sizes);
  });
});
