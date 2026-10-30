/**
 * calibration/test-gguf.ts — a hand-written GGUF v3 file with only metadata, for tests (P6). The memory and window
 * code reads real GGUF metadata from it (block count, heads, KV heads), so a test runs the real arithmetic on a model
 * small enough to write in a temp dir. Named test-*.ts like test-helpers.ts and classifiers/l0/test-fetch.ts (review
 * of 2411e6dc, finding 12): a test-only helper, imported by no production module, so the esbuild entry graph that
 * builds dist/ never reaches it.
 */

import { writeFileSync } from "node:fs";

/** Write `kv` as GGUF metadata: strings, u32 scalars and u32/bool arrays. */
export function writeGguf(file: string, kv: Array<[string, number | string | number[] | boolean[]]>): void {
  const parts: Buffer[] = [Buffer.from("GGUF", "latin1")];
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number): Buffer => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string): Buffer => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  parts.push(u32(3), u64(0), u64(kv.length));
  for (const [k, v] of kv) {
    parts.push(str(k));
    if (typeof v === "string") parts.push(u32(8), str(v));
    else if (typeof v === "number") parts.push(u32(4), u32(v));
    else if (typeof v[0] === "boolean") parts.push(u32(9), u32(7), u64(v.length), Buffer.from((v as boolean[]).map((x) => (x ? 1 : 0))));
    else parts.push(u32(9), u32(4), u64(v.length), ...(v as number[]).map(u32));
  }
  writeFileSync(file, Buffer.concat(parts));
}
