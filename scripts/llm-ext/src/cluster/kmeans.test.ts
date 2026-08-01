// Unit tests for kmeans.ts. Synthetic float32 vectors with known cluster
// structure — the assertions check shape + that the right items end up
// in the right bucket on easy inputs. Mini-batch k-means is approximate,
// so we tolerate occasional swaps; we don't claim optimality.

import { describe, it, expect } from "vitest";
import { kmeans } from "./kmeans.js";

function v(...xs: number[]): Float32Array {
  return new Float32Array(xs);
}

describe("kmeans", () => {
  it("returns empty result on empty input", () => {
    const r = kmeans([], 3);
    expect(r.assignments.length).toBe(0);
    expect(r.centroids).toEqual([]);
  });

  it("clusters two well-separated groups correctly", () => {
    const pts: Float32Array[] = [];
    // Group A around (0,0)
    for (let i = 0; i < 20; i++) pts.push(v(Math.random() * 0.1, Math.random() * 0.1));
    // Group B around (10,10)
    for (let i = 0; i < 20; i++) pts.push(v(10 + Math.random() * 0.1, 10 + Math.random() * 0.1));
    const r = kmeans(pts, 2, { seed: 42 });
    expect(r.centroids).toHaveLength(2);
    expect(r.assignments).toHaveLength(40);

    // Items 0-19 must all share one assignment; items 20-39 the other.
    const labelA = r.assignments[0];
    for (let i = 0; i < 20; i++) expect(r.assignments[i]).toBe(labelA);
    const labelB = r.assignments[20];
    expect(labelB).not.toBe(labelA);
    for (let i = 20; i < 40; i++) expect(r.assignments[i]).toBe(labelB);
  });

  it("caps k at N when k > N", () => {
    const pts = [v(0, 0), v(1, 1), v(2, 2)];
    const r = kmeans(pts, 10, { seed: 1 });
    expect(r.centroids.length).toBeLessThanOrEqual(3);
  });

  it("k=1 returns a single bucket covering all items", () => {
    const pts = [v(0, 0), v(1, 1), v(2, 2), v(3, 3)];
    const r = kmeans(pts, 1, { seed: 1 });
    expect(r.centroids).toHaveLength(1);
    for (const a of r.assignments) expect(a).toBe(0);
  });

  it("is deterministic given the same seed", () => {
    const pts = Array.from({ length: 30 }, (_, i) =>
      v(Math.sin(i) * 5, Math.cos(i) * 5),
    );
    const r1 = kmeans(pts, 4, { seed: 7 });
    const r2 = kmeans(pts, 4, { seed: 7 });
    expect(Array.from(r1.assignments)).toEqual(Array.from(r2.assignments));
  });

  it("throws on k <= 0", () => {
    expect(() => kmeans([v(0, 0)], 0)).toThrow();
    expect(() => kmeans([v(0, 0)], -1)).toThrow();
  });
});
