// Embeddings wrapper for cluster_synonyms (TRDD-220ea89f §4 + §6).
// Two paths: load a precomputed float32 memmap (with sibling
// .meta.json), or spawn compute_embeddings.py via `uv run` to compute
// fresh embeddings from the input items. Both return a flat Float32Array
// plus the dimension and the model id used.
//
// The memmap format is deliberately plain — `bytes_per_row = dim × 4`,
// N rows packed row-major — so it can be produced by any tool (not just
// our sidecar) as long as the sibling .meta.json matches.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ClusterInputItem } from "./types.js";

export interface EmbeddingsBundle {
  /** Flat row-major float32 buffer of length N × dim. */
  embeddings: Float32Array;
  dim: number;
  model: string;
  /** "loaded" = read from existing .f32 file, "computed" = produced by
   *  the Python sidecar during this call. */
  source: "loaded" | "computed";
  /** Path to the on-disk memmap file (callers may keep or delete it). */
  path: string;
}

export interface EmbeddingsMeta {
  shape: [number, number];
  dtype: string;
  model: string;
}

const F32_BYTES = 4;

/** Read + validate the sibling .meta.json that every produced memmap has. */
export function readEmbeddingsMeta(path: string): EmbeddingsMeta {
  const metaPath = path + ".meta.json";
  if (!existsSync(metaPath)) {
    throw new Error(`embeddings meta sidecar missing: ${metaPath}`);
  }
  const raw = readFileSync(metaPath, "utf-8");
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    throw new Error(`embeddings meta is not valid JSON (${metaPath}): ${(err as Error).message}`, { cause: err });
  }
  if (
    typeof meta !== "object" ||
    meta === null ||
    !Array.isArray((meta as EmbeddingsMeta).shape) ||
    (meta as EmbeddingsMeta).shape.length !== 2 ||
    typeof (meta as EmbeddingsMeta).shape[0] !== "number" ||
    typeof (meta as EmbeddingsMeta).shape[1] !== "number"
  ) {
    throw new Error(`embeddings meta missing valid shape [N,D]: ${metaPath}`);
  }
  if (typeof (meta as EmbeddingsMeta).dtype !== "string") {
    throw new Error(`embeddings meta missing dtype: ${metaPath}`);
  }
  if (typeof (meta as EmbeddingsMeta).model !== "string") {
    throw new Error(`embeddings meta missing model: ${metaPath}`);
  }
  return meta as EmbeddingsMeta;
}

/** Read a float32 memmap. Validates byte-count against the meta's shape;
 *  throws on any size mismatch (T5 — embeddings dimension mismatch). */
export function loadEmbeddings(path: string, expectedN?: number): EmbeddingsBundle {
  if (!existsSync(path)) throw new Error(`embeddings file missing: ${path}`);
  const meta = readEmbeddingsMeta(path);
  const [n, dim] = meta.shape;
  if (meta.dtype !== "float32") {
    throw new Error(`embeddings dtype must be float32 (got ${meta.dtype} in ${path}.meta.json)`);
  }
  if (n <= 0 || dim <= 0) {
    throw new Error(`embeddings shape must be positive ([${n}, ${dim}])`);
  }
  if (expectedN !== undefined && n !== expectedN) {
    throw new Error(`embeddings N mismatch: meta says ${n}, caller expected ${expectedN}`);
  }
  const expectedBytes = n * dim * F32_BYTES;
  const stat = statSync(path);
  if (stat.size !== expectedBytes) {
    throw new Error(
      `embeddings file size mismatch: ${path} is ${stat.size} bytes, ` +
        `expected ${expectedBytes} = N(${n}) × D(${dim}) × ${F32_BYTES}`,
    );
  }
  const buf = readFileSync(path);
  // Use a fresh ArrayBuffer slice to guarantee 4-byte alignment for the typed array.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const embeddings = new Float32Array(ab);
  return { embeddings, dim, model: meta.model, source: "loaded", path };
}

export interface ComputeEmbeddingsOpts {
  /** Where the .f32 + .meta.json should land. Must be a writable directory. */
  outDir: string;
  /** Model id passed through to the sidecar. */
  model: string;
  /** Absolute path to compute_embeddings.py. */
  scriptPath: string;
  /** Optional override for the python launcher (default: "uv"). */
  pythonRunner?: string;
  /** Optional sentence cleaner — applied before writing the temp file. */
  sentenceClean?: (s: string) => string;
}

/** Spawn the Python sidecar via `uv run` and load the resulting memmap.
 *  Throws on any non-zero exit, missing OK line, or post-load validation
 *  failure. */
export function computeEmbeddings(
  items: ClusterInputItem[],
  opts: ComputeEmbeddingsOpts,
): EmbeddingsBundle {
  if (items.length === 0) throw new Error("computeEmbeddings: empty items");
  if (!existsSync(opts.scriptPath)) {
    throw new Error(`compute_embeddings.py not found: ${opts.scriptPath}`);
  }
  mkdirSync(opts.outDir, { recursive: true });
  const inputPath = join(opts.outDir, "_embedding_sentences.txt");
  const outputPath = join(opts.outDir, "embeddings.f32");
  const clean = opts.sentenceClean ?? defaultSentenceClean;
  writeFileSync(
    inputPath,
    items.map((it) => clean(it.sentence)).join("\n") + "\n",
    { encoding: "utf-8" },
  );
  const runner = opts.pythonRunner ?? "uv";
  const argv = ["run", opts.scriptPath, "--input", inputPath, "--output", outputPath, "--model", opts.model];
  const result = spawnSync(runner, argv, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`failed to spawn ${runner}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `compute_embeddings.py exited with status ${result.status}\n` +
        `stderr:\n${result.stderr ?? ""}`,
    );
  }
  // Expect a final line "OK <n> <dim> <output_path>"
  const lines = (result.stdout ?? "").split(/\r?\n/).filter((l) => l.length > 0);
  const okLine = lines[lines.length - 1] ?? "";
  if (!okLine.startsWith("OK ")) {
    throw new Error(
      `compute_embeddings.py: missing OK line. Last stdout: ${JSON.stringify(okLine)}`,
    );
  }
  const bundle = loadEmbeddings(outputPath, items.length);
  return { ...bundle, source: "computed" };
}

function defaultSentenceClean(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

/** Round-trip a synthetic embeddings bundle to disk (for tests + for
 *  letting callers persist a freshly-loaded set without re-computing). */
export function writeEmbeddingsToDisk(
  embeddings: Float32Array,
  dim: number,
  model: string,
  outPath: string,
): void {
  const n = embeddings.length / dim;
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`writeEmbeddingsToDisk: bad shape (length=${embeddings.length}, dim=${dim})`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const buf = Buffer.from(embeddings.buffer, embeddings.byteOffset, embeddings.byteLength);
  writeFileSync(outPath, buf);
  const meta: EmbeddingsMeta = { shape: [n, dim], dtype: "float32", model };
  writeFileSync(outPath + ".meta.json", JSON.stringify(meta, null, 2) + "\n", { encoding: "utf-8" });
}
