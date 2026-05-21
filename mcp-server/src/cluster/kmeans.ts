// Mini-batch k-means for float32 vectors. Pure TS, no external deps.
// Used by phase1_batch.ts to group sentence embeddings into roughly
// batch-sized buckets so close-meaning items land in the same LLM call.
//
// The clustering is approximate (we're not after partition optimality —
// just "items in the same bucket are semantically nearby"). Mini-batch
// is plenty good for that job and is O(iters * batchSize * k * D)
// instead of full-batch's O(iters * N * k * D).

export interface KMeansOpts {
  maxIters?: number;       // default 50
  batchSize?: number;      // default 1024
  seed?: number;           // default 0xC1A0B0BA
  tolerance?: number;      // default 1e-4 — drift threshold for early stop
}

export interface KMeansResult {
  assignments: Int32Array;  // length = vectors.length
  centroids: Float32Array[];
}

// Deterministic mulberry32 PRNG (so tests are reproducible).
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sqDist(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const D = a.length;
  for (let i = 0; i < D; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

// k-means++ seeding: pick first centroid uniformly at random, then each
// subsequent centroid with probability ∝ d² to the nearest already-picked
// centroid. Gives a much better starting point than uniform-random.
function kmeansppInit(
  vectors: Float32Array[],
  k: number,
  rng: () => number,
): Float32Array[] {
  const N = vectors.length;
  if (N === 0) return [];
  const centroids: Float32Array[] = [];
  // First: uniformly random.
  centroids.push(new Float32Array(vectors[Math.floor(rng() * N)]));
  const dists = new Float64Array(N);
  for (let i = 0; i < N; i++) dists[i] = sqDist(vectors[i], centroids[0]);
  for (let c = 1; c < k; c++) {
    // Weighted pick by dists.
    let total = 0;
    for (let i = 0; i < N; i++) total += dists[i];
    if (total === 0) {
      // All remaining points collapsed onto existing centroids; pick uniformly.
      centroids.push(new Float32Array(vectors[Math.floor(rng() * N)]));
    } else {
      let r = rng() * total;
      let picked = 0;
      for (let i = 0; i < N; i++) {
        r -= dists[i];
        if (r <= 0) { picked = i; break; }
      }
      centroids.push(new Float32Array(vectors[picked]));
    }
    // Update dists: dists[i] = min(dists[i], ||v_i - new||²)
    const nu = centroids[centroids.length - 1];
    for (let i = 0; i < N; i++) {
      const d = sqDist(vectors[i], nu);
      if (d < dists[i]) dists[i] = d;
    }
  }
  return centroids;
}

function nearestCentroid(v: Float32Array, centroids: Float32Array[]): number {
  let best = 0;
  let bestDist = sqDist(v, centroids[0]);
  for (let c = 1; c < centroids.length; c++) {
    const d = sqDist(v, centroids[c]);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

export function kmeans(
  vectors: Float32Array[],
  k: number,
  opts: KMeansOpts = {},
): KMeansResult {
  const N = vectors.length;
  if (k <= 0) throw new Error("kmeans: k must be positive");
  if (N === 0) {
    return { assignments: new Int32Array(0), centroids: [] };
  }
  const kEff = Math.min(k, N);
  const D = vectors[0].length;
  const maxIters = opts.maxIters ?? 50;
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 1024, N));
  const seed = opts.seed ?? 0xC1A0B0BA;
  const tolerance = opts.tolerance ?? 1e-4;
  const rng = mulberry32(seed);

  const centroids = kmeansppInit(vectors, kEff, rng);
  const counts = new Float64Array(kEff);

  for (let iter = 0; iter < maxIters; iter++) {
    // Pick a mini-batch (with replacement — fine for k-means).
    const batchIdx = new Int32Array(batchSize);
    for (let b = 0; b < batchSize; b++) batchIdx[b] = Math.floor(rng() * N);
    // Streaming-mean centroid update (Sculley 2010 — Web-Scale k-means).
    let maxDrift = 0;
    for (let b = 0; b < batchSize; b++) {
      const idx = batchIdx[b];
      const v = vectors[idx];
      const c = nearestCentroid(v, centroids);
      counts[c]++;
      const eta = 1 / counts[c];
      const cen = centroids[c];
      let drift = 0;
      for (let d = 0; d < D; d++) {
        const old = cen[d];
        cen[d] = old + eta * (v[d] - old);
        const dd = cen[d] - old;
        drift += dd * dd;
      }
      if (drift > maxDrift) maxDrift = drift;
    }
    if (maxDrift < tolerance) break;
  }

  // Final hard assignment pass over all vectors.
  const assignments = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    assignments[i] = nearestCentroid(vectors[i], centroids);
  }
  return { assignments, centroids };
}
