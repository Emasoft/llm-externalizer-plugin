// Streaming JSONL reader + appender for the cluster_synonyms tool.
// JSONL is the input format (one item per line) so the tool can handle
// 1M-row corpora without loading the whole file into memory. See §6 of
// TRDD-220ea89f for the streaming contract.

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { open } from "node:fs/promises";
import type { ClusterInputItem } from "./types.js";

export interface ReadOk<T> {
  ok: true;
  lineNo: number;
  value: T;
}
export interface ReadSkip {
  ok: false;
  lineNo: number;
  reason: string;
  raw: string;
}
export type ReadOutcome<T> = ReadOk<T> | ReadSkip;

/**
 * Stream a JSONL file line-by-line and yield ReadOutcome objects.
 * Blank lines are silently skipped (no outcome emitted). Parse failures
 * yield a ReadSkip — the caller decides whether to log+continue or fail.
 */
export async function* streamJsonl(
  filePath: string,
): AsyncIterable<ReadOutcome<unknown>> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      yield { ok: true, lineNo, value: parsed };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      yield { ok: false, lineNo, reason, raw };
    }
  }
}

/**
 * Validate one parsed JSONL row as a ClusterInputItem. Accepts `sentence`
 * (canonical) and `label` (alias) — the canonical form is always
 * returned. Returns null on validation failure with a reason in the
 * second slot so the caller can log it to stats.warnings.
 */
export function asClusterItem(
  v: unknown,
): { item: ClusterInputItem } | { reason: string } {
  if (v === null || typeof v !== "object") {
    return { reason: "not a JSON object" };
  }
  const o = v as Record<string, unknown>;
  const idVal = o.id;
  if (typeof idVal !== "string" || idVal.trim() === "") {
    return { reason: "missing or empty `id`" };
  }
  // `sentence` is the canonical field; `label` is the documented alias.
  // Prefer `sentence` when both are present; collide warning otherwise.
  const sentVal = typeof o.sentence === "string" ? o.sentence : o.label;
  if (typeof sentVal !== "string" || sentVal.trim() === "") {
    return { reason: "missing or empty `sentence`/`label`" };
  }
  const ctxVal = o.context;
  const item: ClusterInputItem = {
    id: idVal,
    sentence: sentVal,
  };
  if (typeof ctxVal === "string" && ctxVal.trim() !== "") {
    item.context = ctxVal;
  }
  return { item };
}

/**
 * One-shot helper: read a JSONL file and return the validated items
 * plus warnings for skipped/malformed lines and id collisions. For
 * large files prefer to drive `streamJsonl` directly so the in-memory
 * accumulator stays bounded.
 */
export async function readClusterJsonl(filePath: string): Promise<{
  items: ClusterInputItem[];
  warnings: string[];
}> {
  const items: ClusterInputItem[] = [];
  const warnings: string[] = [];
  const seenIds = new Set<string>();

  for await (const out of streamJsonl(filePath)) {
    if (!out.ok) {
      warnings.push(`line ${out.lineNo}: parse error — ${out.reason}`);
      continue;
    }
    const r = asClusterItem(out.value);
    if ("reason" in r) {
      warnings.push(`line ${out.lineNo}: ${r.reason}`);
      continue;
    }
    if (seenIds.has(r.item.id)) {
      warnings.push(
        `line ${out.lineNo}: duplicate id '${r.item.id}' (line kept; downstream merge is undefined)`,
      );
    }
    seenIds.add(r.item.id);
    items.push(r.item);
  }
  return { items, warnings };
}

/**
 * Atomic-ish JSONL writer: writes to a `<path>.tmp` file then renames
 * to the final path. Caller is responsible for not reading the temp
 * path. Use for clusters.jsonl (single batch write at end of run).
 */
export async function writeJsonl<T>(
  filePath: string,
  objs: Iterable<T>,
): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}`;
  const fh = await open(tmp, "w");
  try {
    for (const obj of objs) {
      await fh.write(`${JSON.stringify(obj)}\n`);
    }
  } finally {
    await fh.close();
  }
  await (await import("node:fs/promises")).rename(tmp, filePath);
}

/**
 * Append a single JSONL line. NOT atomic relative to other writers; use
 * for stats-style progressive output where occasional partial lines are
 * acceptable (we always rewrite the full stats.json with writeJsonl at
 * the end).
 */
export function appendJsonlSync(filePath: string, obj: unknown): void {
  const ws = createWriteStream(filePath, { flags: "a" });
  ws.write(`${JSON.stringify(obj)}\n`);
  ws.end();
}
