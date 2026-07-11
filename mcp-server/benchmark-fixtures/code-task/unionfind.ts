// Union-find with path compression + union by rank, keyed by arbitrary
// string ids. Used by phase1_batch.ts and phase2_verify.ts to merge
// clusters as the LLM groups items together.
//
// In-memory only — checkpoint.ts mirrors the (item_id → parent_id) edges
// to SQLite so resume can rehydrate the structure. The transitive-closure
// merge logic from §7 / Q12 lives in phase2_verify.ts; this module only
// provides the data structure.

export class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();
  private sizes = new Map<string, number>();

  /**
   * Add an item if it does not already exist. New items start as
   * their own cluster (singleton).
   */
  add(id: string): void {
    if (this.parent.has(id)) return;
    this.parent.set(id, id);
    this.rank.set(id, 0);
    this.sizes.set(id, 1);
  }

  has(id: string): boolean {
    return this.parent.has(id);
  }

  /**
   * Find the root of `id` with path compression. Throws if the id is
   * not in the structure — callers should always `add()` first.
   */
  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) throw new Error(`UnionFind.find: unknown id '${id}'`);
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }

  /**
   * Union two items. Returns the root of the merged set, or null if
   * the two were already in the same set.
   */
  union(a: string, b: string): string | null {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return null;
    const ranka = this.rank.get(ra) ?? 0;
    const rankb = this.rank.get(rb) ?? 0;
    const sizea = this.sizes.get(ra) ?? 1;
    const sizeb = this.sizes.get(rb) ?? 1;
    let newRoot: string;
    let absorbed: string;
    if (ranka < rankb) {
      this.parent.set(ra, rb);
      newRoot = rb;
      absorbed = ra;
    } else if (ranka > rankb) {
      this.parent.set(rb, ra);
      newRoot = ra;
      absorbed = rb;
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, ranka + 1);
      newRoot = ra;
      absorbed = rb;
    }
    this.sizes.set(newRoot, sizea + sizeb);
    this.sizes.delete(absorbed);
    return newRoot;
  }

  /**
   * Size of the cluster containing `id`. Throws on unknown id.
   */
  sizeOf(id: string): number {
    const root = this.find(id);
    return this.sizes.get(root) ?? 1;
  }

  /**
   * Number of distinct clusters currently in the structure.
   */
  numClusters(): number {
    return this.sizes.size;
  }

  /**
   * Materialise the current partition as Map<root, item[]>. Linear pass
   * — call infrequently (typically only at emit time in phase4).
   */
  partition(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      let arr = out.get(root);
      if (!arr) {
        arr = [];
        out.set(root, arr);
      }
      arr.push(id);
    }
    return out;
  }

  /**
   * Snapshot the (item → parent) edges. Used by checkpoint.ts to mirror
   * the structure to SQLite. Note: this is the LAZY edges (compressed
   * during find()), not the original union order — that's fine because
   * the partition is what matters.
   */
  edges(): Array<[string, string]> {
    return Array.from(this.parent.entries());
  }

  /**
   * Rehydrate from a previous `edges()` snapshot (from checkpoint).
   * Items not already present are added; `find()` on any reconstructed
   * id will compress the path on demand.
   */
  static fromEdges(edges: Iterable<[string, string]>): UnionFind {
    const uf = new UnionFind();
    // First pass: add every id as a singleton.
    for (const [a, b] of edges) {
      uf.add(a);
      uf.add(b);
    }
    // Second pass: install parent pointers without rank/size mutation.
    // We then walk find() on every node to recompute sizes from scratch.
    for (const [a, b] of edges) {
      uf.parent.set(a, b);
    }
    // Recompute sizes by counting cluster membership from current parent map.
    const counts = new Map<string, number>();
    for (const id of uf.parent.keys()) {
      const root = uf.find(id);
      counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    uf.sizes = counts;
    // Rank is approximate after rehydrate — we leave existing ranks as 0
    // which biases future unions slightly toward depth balance, but
    // correctness is preserved.
    return uf;
  }
}
