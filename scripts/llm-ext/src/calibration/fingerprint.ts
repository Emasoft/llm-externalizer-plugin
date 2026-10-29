/**
 * calibration/fingerprint.ts — what a record was measured on (P6; spec
 * section 3, round-2 review N7): the sha256 of every weight file's CONTENT and
 * the machine's total RAM. Never the repository revision: a README commit
 * changes the revision but not the weights, and must not trigger hours of
 * re-calibration (ruling L73).
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { basename, join } from "node:path";
import type { Fingerprint } from "./record.js";

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The sha256 of a weight file's content. In a Hugging Face cache a snapshot
 * file is a symlink to `blobs/<sha256 of the content>`, so the name IS the
 * hash and nothing is read; any other file (a plain .gguf path) is hashed.
 */
export async function blobSha256(file: string): Promise<string> {
  const real = realpathSync(file);
  const name = basename(real);
  if (SHA256_RE.test(name) && basename(join(real, "..")) === "blobs") return name;
  const h = createHash("sha256");
  for await (const chunk of createReadStream(real)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** The Hugging Face hub cache: HF_HUB_CACHE, else HF_HOME/hub, else ~/.cache/huggingface/hub (huggingface_hub's own order). */
export function hfHubCache(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, "hub");
  return join(homedir(), ".cache", "huggingface", "hub");
}

/** Weight files of an MLX snapshot (what Locals loads). */
const WEIGHT_RE = /\.(safetensors|gguf|npz)$/;

/**
 * The weight files of a Hugging Face repo's snapshot in the hub cache, at the
 * revision `refs/main` names. Throws when the repo is not cached: the cal
 * server has just loaded it, so a missing snapshot is a real error.
 */
export function snapshotWeightFiles(repo: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const root = join(hfHubCache(env), `models--${repo.replace(/\//g, "--")}`);
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

/** The fingerprint of the files a server loaded. */
export async function fingerprintOf(files: readonly string[]): Promise<Fingerprint> {
  const blobs = await Promise.all(files.map((f) => blobSha256(f)));
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

/**
 * Read the identity from a live server llm-ext started: llama-server's /props
 * names the GGUF it loaded and its build; for Locals the weights are the
 * repo's cached snapshot and /health gives the version and build. The runner
 * records exactly this, and the broker compares exactly this when it loads a
 * main server, so the two can never disagree on format.
 */
export async function loadedIdentity(engine: "llama" | "locals", baseUrl: string, apiKey: string, model: string): Promise<LoadedIdentity> {
  if (engine === "llama") {
    const res = await fetch(`${baseUrl}/props`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    const props = (await res.json()) as { model_path?: unknown; build_info?: unknown };
    if (typeof props.model_path !== "string" || props.model_path === "") throw new Error(`llama-server /props names no model_path for '${model}'`);
    if (typeof props.build_info !== "string" || props.build_info === "") throw new Error("llama-server /props names no build_info");
    return { fingerprint: await fingerprintOf([props.model_path]), engineVersion: props.build_info };
  }
  const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  const h = (await res.json()) as { version?: unknown; build?: unknown };
  if (typeof h.version !== "string") throw new Error("the Locals server /health names no version");
  return { fingerprint: await fingerprintOf(snapshotWeightFiles(model)), engineVersion: typeof h.build === "string" ? `${h.version}+${h.build}` : h.version };
}

/**
 * Does a record still describe what is loaded (spec section 3, review F3)?
 * "weights": a blob or the RAM changed (full recalibration); "engine": the
 * build changed (the quick check re-runs Phase A); null: it matches.
 */
export function staleness(record: { fingerprint: Fingerprint; engine_version_checked: string }, now: LoadedIdentity): "weights" | "engine" | null {
  if (!sameFingerprint(record.fingerprint, now.fingerprint)) return "weights";
  if (record.engine_version_checked !== now.engineVersion) return "engine";
  return null;
}
