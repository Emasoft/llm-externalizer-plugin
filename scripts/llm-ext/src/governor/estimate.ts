/**
 * governor/estimate.ts — a model's RAM figures from the files on disk, before
 * it is loaded (design/specs/local-inference-governor-design.md D11, round 2
 * #4). Phase C records them as `load_estimate`, required on an ok record since
 * harness version 6 (round 4 #8); a calibration server started before any
 * record exists reads the same figures here, the way Phase C does: weightBytes
 * of the weight files and kvBytes of the shape in their GGUF metadata or MLX
 * config.json. Null when the files are not all on disk: that is a first
 * download, and the size is not known before the download ends.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { kvBytes, modelKvLayers, weightBytes, WINDOW_HEADROOM_BYTES } from "../calibration/memory.js";
import { hfCacheDir, parseManagedModel } from "../local-llama-server.js";
import { hubCacheDir, parseLocalsModel } from "../local-locals-server.js";

export interface LoadEstimate {
  weight_bytes: number;
  kv_bytes_per_token: number;
}

/** The files of the `refs/main` snapshot of a cached repo, or null when it is not cached. */
function snapshotFiles(cacheDir: string, repo: string): string[] | null {
  const root = join(cacheDir, `models--${repo.replace(/\//g, "--")}`);
  const ref = join(root, "refs", "main");
  if (!existsSync(ref)) return null;
  const snap = join(root, "snapshots", readFileSync(ref, "utf8").trim());
  if (!existsSync(snap)) return null;
  return readdirSync(snap, { recursive: true })
    .map(String)
    .map((f) => join(snap, f))
    .sort();
}

/** The snapshot files whose content is one of `blobs` (the record's fingerprint), all of them or null. */
function filesOfBlobs(files: readonly string[] | null, blobs: readonly string[]): string[] | null {
  if (files === null) return null;
  const found = new Map<string, string>();
  for (const f of files) {
    try {
      const sha = basename(realpathSync(f));
      if (blobs.includes(sha) && !found.has(sha)) found.set(sha, f);
    } catch {
      /* a dangling link: an unfinished download */
    }
  }
  return found.size === blobs.length ? [...found.values()].sort() : null;
}

/**
 * The weight files a server of `model` would load, or null when that is not
 * known without loading it. `blobs` is a record's fingerprint, which names the
 * exact files; without it only a plain path and an org/repo/file.gguf name do.
 * Sorted, so a split GGUF's first shard (the one with the metadata) comes first.
 */
export function weightFilesOnDisk(engine: "llama" | "locals", model: string, blobs: readonly string[] | null, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (engine === "locals") {
    if ("error" in parseLocalsModel(model)) return null;
    const files = snapshotFiles(hubCacheDir(env), model)?.filter((f) => /\.(safetensors|gguf|npz)$/.test(f)) ?? null;
    if (files === null || files.length === 0) return null;
    return blobs === null ? files : filesOfBlobs(files, blobs);
  }
  const parsed = parseManagedModel(model);
  if ("error" in parsed) return null;
  if (parsed.kind === "file") {
    const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i.exec(model);
    const shards = m ? Array.from({ length: Number(m[3]) }, (_, i) => `${m[1]}-${String(i + 1).padStart(5, "0")}-of-${m[3]}.gguf`) : [model];
    return shards.every((f) => existsSync(f)) ? shards : null;
  }
  const repo = parsed.kind === "hf" ? parsed.argv[1].split(":")[0] : parsed.argv[1];
  const files = snapshotFiles(hfCacheDir(env), repo);
  if (blobs !== null) return filesOfBlobs(files, blobs);
  // An org/repo:quant tag names no file: llama.cpp picks it at load time. Only a named file is known before that.
  if (parsed.kind !== "hf-file" || files === null) return null;
  const named = files.filter((f) => f.endsWith(`/${parsed.argv[3]}`));
  return named.length === 1 ? named : null;
}

/**
 * Phase C's own figures (calibration/phase-c.ts, C/summary) from files on disk; null when there are none. Round 4 #10:
 * only a missing file (ENOENT: a dangling link, or a file removed since it was listed) means "not known"; any other
 * error (an unreadable or malformed file) is thrown, never turned into an unknown size that would load the model alone.
 */
export function estimateFromFiles(engine: "llama" | "locals", files: readonly string[] | null): LoadEstimate | null {
  if (files === null || files.length === 0) return null;
  try {
    return { weight_bytes: weightBytes(files), kv_bytes_per_token: kvBytes(modelKvLayers(engine, files), 1) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const cache = new Map<string, LoadEstimate | null>();

/** `estimateFromFiles(weightFilesOnDisk(...))`, kept per model and fingerprint: the files of one fingerprint never change. */
export function estimateOnDisk(engine: "llama" | "locals", model: string, blobs: readonly string[] | null): LoadEstimate | null {
  const key = `${engine}\u0000${model}\u0000${blobs?.join(",") ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const est = estimateFromFiles(engine, weightFilesOnDisk(engine, model, blobs));
  // Only a found estimate is kept: a missing one may be a download that finishes later.
  if (est !== null) cache.set(key, est);
  return est;
}

/**
 * What a load needs, from an estimate: `bytes` the upper bound (weights, KV of
 * `tokens`, the headroom Phase C keeps, and `extraBytes`), `minBytes` the
 * lower bound (weights, headroom and `minExtraBytes`: a Locals load passes the
 * smallest prompt cache, LOCALS_CACHE_MIN_GB, so a grant on its lower bound
 * leaves room for it; round 5 M2(a)). `tokens` 0 means the context is not
 * known before the load: the upper bound is then unknown, 0.
 */
export function loadBounds(est: LoadEstimate, tokens: number, extraBytes = 0, minExtraBytes = 0): { bytes: number; minBytes: number } {
  const base = est.weight_bytes + WINDOW_HEADROOM_BYTES;
  return { bytes: tokens > 0 ? base + est.kv_bytes_per_token * tokens + extraBytes : 0, minBytes: base + minExtraBytes };
}
