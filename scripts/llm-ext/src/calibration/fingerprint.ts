/**
 * calibration/fingerprint.ts — what a record was measured on (P6; spec
 * section 3, round-2 review N7): the sha256 of every weight file's CONTENT and
 * the machine's total RAM. Never the repository revision: a README commit
 * changes the revision but not the weights, and must not trigger hours of
 * re-calibration (ruling L73).
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, dirname, join } from "node:path";
import { hubCacheDir } from "../local-locals-server.js";
import { FIXTURE_VERSION, HARNESS_VERSION, type Fingerprint } from "./record.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

/** `<config dir>/calibration/digests.json`: content hashes of plain weight files, by (path, dev, inode, size, mtime). */
const digestCachePath = (dir: string): string => join(dir, "calibration", "digests.json");
type DigestCache = Record<string, { dev: number; ino: number; size: number; mtimeMs: number; sha256: string }>;

function readDigests(dir: string): DigestCache {
  try {
    const raw = JSON.parse(readFileSync(digestCachePath(dir), "utf8")) as unknown;
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as DigestCache) : {};
  } catch {
    return {};
  }
}

/**
 * The sha256 of a weight file's content. In a Hugging Face cache a snapshot
 * file is a symlink to `blobs/<sha256 of the content>`, so the name IS the
 * hash and nothing is read. Any other file (a plain .gguf path, llama.cpp's
 * own download cache) is hashed once and the digest kept under `dir`, keyed
 * by path, device, inode, size and mtime (review M7: before, every main-server
 * load streamed the whole file, tens of seconds for a large model). A file
 * that changes in any of those is hashed again.
 */
export async function blobSha256(file: string, dir?: string): Promise<string> {
  const real = realpathSync(file);
  const name = basename(real);
  if (SHA256_RE.test(name) && basename(dirname(real)) === "blobs") return name;
  const st = statSync(real);
  const cached = dir === undefined ? undefined : readDigests(dir)[real];
  if (cached && cached.dev === st.dev && cached.ino === st.ino && cached.size === st.size && cached.mtimeMs === st.mtimeMs && SHA256_RE.test(cached.sha256)) return cached.sha256;
  const h = createHash("sha256");
  for await (const chunk of createReadStream(real)) h.update(chunk as Buffer);
  const sha256 = h.digest("hex");
  if (dir !== undefined) {
    // Read-modify-write without a lock: two writers can only lose an entry, which is re-hashed next time.
    const all = readDigests(dir);
    all[real] = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, sha256 };
    mkdirSync(dirname(digestCachePath(dir)), { recursive: true });
    const tmp = `${digestCachePath(dir)}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, digestCachePath(dir));
  }
  return sha256;
}

/** Weight files of an MLX snapshot (what Locals loads). */
const WEIGHT_RE = /\.(safetensors|gguf|npz)$/;

/**
 * The weight files of a Hugging Face repo's snapshot in the hub cache, at the
 * revision `refs/main` names. The cache directory is the one the Locals
 * server itself uses (`hubCacheDir`, review M4: a second resolver here had
 * drifted and ignored XDG_CACHE_HOME). Throws when the repo is not cached:
 * the server has just loaded it, so a missing snapshot is a real error.
 */
export function snapshotWeightFiles(repo: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = join(hubCacheDir(env), `models--${repo.replace(/\//g, "--")}`);
  const refFile = join(root, "refs", "main");
  if (!existsSync(refFile)) throw new Error(`no cached snapshot of '${repo}' under ${root} (refs/main missing)`);
  const snap = join(root, "snapshots", readFileSync(refFile, "utf8").trim());
  const files = readdirSync(snap, { recursive: true })
    .map(String)
    .filter((f) => WEIGHT_RE.test(f))
    .map((f) => join(snap, f));
  if (files.length === 0) throw new Error(`the cached snapshot ${snap} has no weight files`);
  return files;
}

/**
 * Every shard of a split GGUF (`name-00001-of-00003.gguf`): llama-server's
 * /props names only the first, and a change to another shard must change the
 * fingerprint too (review M7). A single file is returned alone.
 */
export function ggufShards(modelPath: string): string[] {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/.exec(modelPath);
  if (!m) return [modelPath];
  const n = Number(m[3]);
  return Array.from({ length: n }, (_, i) => `${m[1]}-${String(i + 1).padStart(5, "0")}-of-${m[3]}.gguf`);
}

/** The fingerprint of the files a server loaded (digests of plain files cached under `dir`). */
export async function fingerprintOf(files: readonly string[], dir?: string): Promise<Fingerprint> {
  const blobs: string[] = [];
  for (const f of files) blobs.push(await blobSha256(f, dir));
  return { blobs: [...new Set(blobs)].sort(), ram_bytes: totalmem() };
}

/** Two fingerprints describe the same weights on the same machine. */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.ram_bytes === b.ram_bytes && a.blobs.length === b.blobs.length && a.blobs.every((x, i) => x === b.blobs[i]);
}

/** What a running server loaded: the weights' fingerprint and the engine build (spec section 3). */
export interface LoadedIdentity {
  fingerprint: Fingerprint;
  /** llama-server /props build_info ("b11960-8642541b2"); Locals /health "<version>+<build>". */
  engineVersion: string;
}

async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  // Review m4: a 401 or 500 says so, instead of surfacing as a JSON parse error.
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`${url} did not answer JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Read the identity from a live server llm-ext started: llama-server's /props
 * names the GGUF it loaded and its build; for Locals the weights are the
 * repo's cached snapshot and /health gives the version and build. The runner
 * records exactly this, and the broker compares exactly this when it loads a
 * main server, so the two can never disagree on format. `dir` is the config
 * dir (the digest cache).
 */
export async function loadedIdentity(engine: "llama" | "locals", baseUrl: string, apiKey: string, model: string, dir: string): Promise<LoadedIdentity> {
  if (engine === "llama") {
    const props = await getJson(`${baseUrl}/props`, { authorization: `Bearer ${apiKey}` });
    if (typeof props.model_path !== "string" || props.model_path === "") throw new Error(`llama-server /props names no model_path for '${model}'`);
    if (typeof props.build_info !== "string" || props.build_info === "") throw new Error("llama-server /props names no build_info");
    return { fingerprint: await fingerprintOf(ggufShards(props.model_path), dir), engineVersion: props.build_info };
  }
  const h = await getJson(`${baseUrl}/health`, {});
  if (typeof h.version !== "string") throw new Error("the Locals server /health names no version");
  return { fingerprint: await fingerprintOf(snapshotWeightFiles(model), dir), engineVersion: typeof h.build === "string" ? `${h.version}+${h.build}` : h.version };
}

/**
 * Does a record still describe what is loaded (spec section 3, review F3)?
 * "weights": a blob or the RAM changed, or the record is of another harness or
 * fixture version (review M5; full recalibration); "engine": the build changed
 * (the quick check re-runs Phase A); null: it matches.
 */
export function staleness(
  record: { fingerprint: Fingerprint; engine_version_checked: string; harness_version: number; fixture_version: number },
  now: LoadedIdentity,
): "weights" | "engine" | null {
  if (record.harness_version !== HARNESS_VERSION || record.fixture_version !== FIXTURE_VERSION) return "weights";
  if (!sameFingerprint(record.fingerprint, now.fingerprint)) return "weights";
  if (record.engine_version_checked !== now.engineVersion) return "engine";
  return null;
}
