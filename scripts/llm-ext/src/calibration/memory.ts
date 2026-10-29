/**
 * calibration/memory.ts — the memory estimate made before a cal server loads
 * (P6; design/specs/local-calibration-design.md section 4.1, review F21, A7).
 *
 * KV bytes per token = the sum, over the layers that hold a KV cache, of
 * (key length + value length) x n_head_kv x 2 bytes (f16). A sliding-window
 * layer holds min(W, window) tokens instead of W. When the metadata names
 * neither the per-layer KV heads nor the layer types, every layer counts in
 * full: an overestimate, which is the safe side.
 *
 * W is the largest context with weights + KV(W) + 1 GB under the free memory
 * minus the broker's memory floor, at most the harness's window cap.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { memoryFreePercent } from "../local-locals-server.js";

/** One layer's KV shape: elements per token for K plus V (0 = no KV), and its sliding window (0 = full attention). */
export interface KvLayer {
  kvElems: number;
  window: number;
}

/** Bytes per element of the f16 KV cache llama-server and Locals use by default. */
const KV_ELEM_BYTES = 2;
/** Headroom kept free beside the weights and the KV cache (spec 4.1). */
export const WINDOW_HEADROOM_BYTES = 1024 ** 3;
/** W is chosen in steps of this many tokens. */
const WINDOW_STEP = 256;

// ── GGUF metadata (the header only; tensors are never read) ─────────────

type GgufValue = number | bigint | boolean | string | GgufValue[];

/**
 * The key/value metadata of a GGUF file (v2 and v3). Large arrays (the
 * tokenizer's vocabulary) are skipped, not kept: only arrays of at most
 * `keepArray` items are returned, which covers every per-layer array.
 */
export function readGgufMetadata(file: string, keepArray = 4096): Map<string, GgufValue> {
  const fd = openSync(file, "r");
  const size = statSync(file).size;
  let buf = Buffer.alloc(0);
  let bufStart = 0;
  let pos = 0;
  const need = (n: number): void => {
    if (pos + n > size) throw new Error(`${file}: the GGUF header ends early (offset ${pos}, needs ${n} bytes)`);
    if (pos >= bufStart && pos + n <= bufStart + buf.length) return;
    const len = Math.max(n, 1 << 20);
    buf = Buffer.alloc(Math.min(len, size - pos));
    readSync(fd, buf, 0, buf.length, pos);
    bufStart = pos;
  };
  const u32 = (): number => {
    need(4);
    const v = buf.readUInt32LE(pos - bufStart);
    pos += 4;
    return v;
  };
  const u64 = (): bigint => {
    need(8);
    const v = buf.readBigUInt64LE(pos - bufStart);
    pos += 8;
    return v;
  };
  const str = (): string => {
    const n = Number(u64());
    need(n);
    const s = buf.toString("utf8", pos - bufStart, pos - bufStart + n);
    pos += n;
    return s;
  };
  const FIXED: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const scalar = (t: number): GgufValue => {
    const w = FIXED[t];
    if (w === undefined) throw new Error(`${file}: unknown GGUF value type ${t} at offset ${pos}`);
    need(w);
    const o = pos - bufStart;
    pos += w;
    switch (t) {
      case 0: return buf.readUInt8(o);
      case 1: return buf.readInt8(o);
      case 2: return buf.readUInt16LE(o);
      case 3: return buf.readInt16LE(o);
      case 4: return buf.readUInt32LE(o);
      case 5: return buf.readInt32LE(o);
      case 6: return buf.readFloatLE(o);
      case 7: return buf.readUInt8(o) !== 0;
      case 10: return buf.readBigUInt64LE(o);
      case 11: return buf.readBigInt64LE(o);
      default: return buf.readDoubleLE(o);
    }
  };
  const value = (t: number): GgufValue => {
    if (t === 8) return str();
    if (t !== 9) return scalar(t);
    const it = u32();
    const n = Number(u64());
    if (n > keepArray && it !== 8 && it !== 9) {
      // Skip a large fixed-width array without reading it.
      const w = FIXED[it];
      if (w === undefined) throw new Error(`${file}: unknown GGUF array type ${it}`);
      pos += w * n;
      return [];
    }
    const out: GgufValue[] = [];
    for (let i = 0; i < n; i++) {
      const v = value(it);
      if (n <= keepArray) out.push(v);
    }
    return out;
  };
  try {
    need(4);
    if (buf.toString("latin1", pos - bufStart, pos - bufStart + 4) !== "GGUF") throw new Error(`${file} is not a GGUF file`);
    pos += 4;
    const version = u32();
    if (version < 2) throw new Error(`${file}: GGUF version ${version} is not supported (2 or 3)`);
    u64(); // tensor count
    const kvCount = Number(u64());
    const meta = new Map<string, GgufValue>();
    for (let i = 0; i < kvCount; i++) {
      const key = str();
      meta.set(key, value(u32()));
    }
    return meta;
  } finally {
    closeSync(fd);
  }
}

const num = (v: GgufValue | undefined): number | null => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null);

/**
 * The KV layers of a GGUF model from its metadata (spec 4.1): a per-layer
 * `head_count_kv` array with 0 entries marks layers without KV (LFM3's
 * convolution layers); `sliding_window` with a per-layer pattern marks
 * sliding-window layers. A pattern that is missing or not understood makes
 * every layer full (safe).
 */
export function ggufKvLayers(meta: Map<string, GgufValue>): KvLayer[] {
  const arch = meta.get("general.architecture");
  if (typeof arch !== "string") throw new Error("the GGUF metadata names no general.architecture");
  const k = (s: string): GgufValue | undefined => meta.get(`${arch}.${s}`);
  const layers = num(k("block_count"));
  if (layers === null || layers <= 0) throw new Error(`the GGUF metadata has no ${arch}.block_count`);
  const heads = num(k("attention.head_count"));
  const embd = num(k("embedding_length"));
  const headDim = heads && embd ? embd / heads : null;
  const keyLen = num(k("attention.key_length")) ?? headDim;
  const valLen = num(k("attention.value_length")) ?? headDim;
  if (keyLen === null || valLen === null) throw new Error(`the GGUF metadata gives no head size for ${arch}`);
  const kvRaw = k("attention.head_count_kv") ?? k("attention.head_count");
  const kvHeads: number[] = Array.isArray(kvRaw) ? kvRaw.map((v) => num(v) ?? 0) : Array.from({ length: layers }, () => num(kvRaw) ?? 0);
  if (kvHeads.length !== layers || (!Array.isArray(kvRaw) && kvHeads[0] <= 0)) throw new Error(`the GGUF metadata has no usable ${arch}.attention.head_count_kv`);
  const window = num(k("attention.sliding_window")) ?? 0;
  const pattern = k("attention.sliding_window_pattern");
  const swa = (i: number): boolean => {
    if (window <= 0) return false;
    // A per-layer bool array: true = sliding-window layer.
    if (Array.isArray(pattern) && pattern.length === layers) return pattern[i] === true;
    // A period n: every n-th layer is full attention, the others slide (llama.cpp's convention).
    const n = num(pattern);
    if (n !== null && n > 1) return (i + 1) % n !== 0;
    return false; // not understood: count the layer in full
  };
  // A hybrid model (Qwen3.5): only every n-th layer is attention; the others are linear (no KV cache). Its trailing
  // multi-token-prediction layers (nextn_predict_layers) are counted in full, the safe side.
  const interval = num(k("full_attention_interval"));
  const nextn = num(k("nextn_predict_layers")) ?? 0;
  const hasKv = (i: number): boolean => interval === null || interval <= 1 || (i + 1) % interval === 0 || i >= layers - nextn;
  // A looped model (Nanbeige num_loops) runs its layers that many times; each pass is counted, the safe side.
  const loops = Math.max(1, num(k("num_loops")) ?? 1);
  return kvHeads.map((h, i) => ({ kvElems: hasKv(i) ? loops * h * (keyLen + valLen) : 0, window: swa(i) ? window : 0 }));
}

/**
 * The KV layers of an MLX model from its `config.json` (spec 4.1):
 * `layer_types` (or `full_attention_interval`), `num_key_value_heads`,
 * `head_dim` and `sliding_window`. A layer type that is neither full nor
 * sliding attention (convolution, linear attention) holds no KV cache.
 */
export function configKvLayers(cfgRaw: Record<string, unknown>): KvLayer[] {
  const cfg = (typeof cfgRaw.text_config === "object" && cfgRaw.text_config !== null ? cfgRaw.text_config : cfgRaw) as Record<string, unknown>;
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const layers = n(cfg.num_hidden_layers);
  if (layers === null || layers <= 0) throw new Error("config.json has no num_hidden_layers");
  const heads = n(cfg.num_attention_heads);
  const hidden = n(cfg.hidden_size);
  const headDim = n(cfg.head_dim) ?? (heads && hidden ? hidden / heads : null);
  if (headDim === null) throw new Error("config.json gives no head size (head_dim, or hidden_size and num_attention_heads)");
  const kv = n(cfg.num_key_value_heads) ?? heads;
  if (kv === null) throw new Error("config.json gives no num_key_value_heads");
  const window = n(cfg.sliding_window) ?? 0;
  const types = Array.isArray(cfg.layer_types) && cfg.layer_types.length === layers ? (cfg.layer_types as unknown[]).map(String) : null;
  const interval = n(cfg.full_attention_interval);
  // A looped model (Nanbeige num_loops) runs its layers that many times; each pass is counted, the safe side.
  const loops = Math.max(1, n(cfg.num_loops) ?? 1);
  return Array.from({ length: layers }, (_, i) => {
    let kind: "full" | "sliding" | "none" = "full";
    if (types) kind = /sliding/.test(types[i]) ? "sliding" : /full|^attention$|global/.test(types[i]) ? "full" : "none";
    else if (interval !== null && interval > 1) kind = (i + 1) % interval === 0 ? "full" : "none";
    return { kvElems: kind === "none" ? 0 : loops * 2 * kv * headDim, window: kind === "sliding" && window > 0 ? window : 0 };
  });
}

/** KV cache bytes for `tokens` tokens of context in one slot. */
export function kvBytes(layers: readonly KvLayer[], tokens: number): number {
  let b = 0;
  for (const l of layers) b += l.kvElems * KV_ELEM_BYTES * (l.window > 0 ? Math.min(tokens, l.window) : tokens);
  return b;
}

/**
 * W (spec 4.1): the largest multiple of 256 tokens, at most `cap`, with
 * weights + KV(W) + 1 GB at or under `budget` (free memory minus the floor).
 * 0 when not even 256 tokens fit.
 */
export function chooseWindow(layers: readonly KvLayer[], weightBytes: number, budget: number, cap: number): number {
  const fits = (w: number): boolean => weightBytes + kvBytes(layers, w) + WINDOW_HEADROOM_BYTES <= budget;
  let lo = 0;
  let hi = Math.floor(cap / WINDOW_STEP);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid * WINDOW_STEP)) lo = mid;
    else hi = mid - 1;
  }
  return lo * WINDOW_STEP;
}

/** The KV layers of what a cal server will load: the GGUF it named, or the MLX snapshot's config.json. */
export function modelKvLayers(engine: "llama" | "locals", weightFiles: readonly string[]): KvLayer[] {
  if (weightFiles.length === 0) throw new Error("no weight files to read the model shape from");
  if (engine === "llama") return ggufKvLayers(readGgufMetadata(weightFiles[0]));
  // The snapshot root holds config.json; weight files may sit in a subdirectory of it.
  for (let d = dirname(weightFiles[0]); ; d = dirname(d)) {
    const cfg = join(d, "config.json");
    if (existsSync(cfg)) return configKvLayers(JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>);
    if (/\/snapshots$/.test(dirname(d)) || dirname(d) === d) break;
  }
  throw new Error(`no config.json beside ${weightFiles[0]}`);
}

/** Total size of the weight files (followed through Hugging Face symlinks). */
export function weightBytes(files: readonly string[]): number {
  return files.reduce((s, f) => s + statSync(f).size, 0);
}

/**
 * Free memory now, and the broker's floor, in bytes. darwin: memory_pressure's
 * free percentage (it counts inactive and purgeable memory, as the broker's
 * own gate does); elsewhere os.freemem(). The floor is LLM_EXT_BROKER_MEMORY_FLOOR
 * percent of RAM (default 10), the same value the broker gates Locals with.
 */
export async function freeMemory(floorPct: number): Promise<{ free: number; floor: number }> {
  const total = totalmem();
  let free = freemem();
  if (platform() === "darwin") {
    const pct = await memoryFreePercent();
    if (pct === null) throw new Error("memory_pressure gave no reading: the calibration window cannot be measured");
    free = Math.round((pct / 100) * total);
  }
  return { free, floor: Math.round((floorPct / 100) * total) };
}
