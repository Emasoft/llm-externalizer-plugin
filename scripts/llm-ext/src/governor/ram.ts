/**
 * governor/ram.ts — RAM used on this machine, the one reading the governor,
 * its load watchdog and calibration share (design/specs/local-inference-governor-design.md D4,
 * round 3; measured in reports_dev/governor/20261031_144619+0100-ram-reading-measure.md
 * and 20261031_145637+0100-model-load-ram-measure.md).
 *
 * macOS: (Anonymous pages + Pages wired down + Pages occupied by compressor) x
 * page size, from one `vm_stat` (about 8 ms, as memory_pressure). Measured: it
 * tracks a 6 GiB anonymous allocation within 1 to 2 s and in proportion, and a
 * loaded llama.cpp model (mmap or not) within 3 to 5 s as wired pages, while
 * memory_pressure's free percentage moved 1 point for the same 6 GiB, because it
 * counts reclaimable memory as free. File-backed pages are the GGUF's page cache,
 * reclaimable: counting them would count the weights twice. An idle MLX (Locals)
 * server's wired pages drop to 0, so the governor adds those servers from its
 * books (controller loadFits), not from this reading.
 * Linux (unverified): MemTotal - MemAvailable from /proc/meminfo.
 * Windows (unverified): os.totalmem() - os.freemem(), as before round 3.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";

export interface RamReading {
  usedBytes: number;
  totalBytes: number;
}

const VM_STAT_FIELDS = ["Anonymous pages", "Pages wired down", "Pages occupied by compressor"] as const;

/** Bytes used from `vm_stat` output. A missing field or page size is an error: never a default (fail fast). */
export function vmStatUsedBytes(text: string): number {
  const page = /page size of (\d+) bytes/.exec(text);
  if (!page) throw new Error("vm_stat printed no page size");
  let pages = 0;
  for (const field of VM_STAT_FIELDS) {
    const m = new RegExp(`^${field}:\\s+(\\d+)\\.`, "m").exec(text);
    if (!m) throw new Error(`vm_stat printed no '${field}' line`);
    pages += Number(m[1]);
  }
  return pages * Number(page[1]);
}

/** Bytes used from /proc/meminfo: MemTotal - MemAvailable (kB). A missing field is an error. */
export function meminfoUsedBytes(text: string): number {
  const kb = (field: string): number => {
    const m = new RegExp(`^${field}:\\s+(\\d+) kB`, "m").exec(text);
    if (!m) throw new Error(`/proc/meminfo has no ${field} line`);
    return Number(m[1]) * 1024;
  };
  return kb("MemTotal") - kb("MemAvailable");
}

function vmStat(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("vm_stat", [], { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } }, (err, stdout) => {
      if (err) reject(new Error(`vm_stat failed: ${err.message}`));
      else resolve(String(stdout));
    });
  });
}

/** RAM used now. Throws when it cannot be read: a reading that silently defaulted would let a load through blind. */
export async function readRam(): Promise<RamReading> {
  const totalBytes = totalmem();
  const os = platform();
  if (os === "darwin") return { usedBytes: vmStatUsedBytes(await vmStat()), totalBytes };
  if (os === "linux") return { usedBytes: meminfoUsedBytes(readFileSync("/proc/meminfo", "utf8")), totalBytes };
  return { usedBytes: totalBytes - freemem(), totalBytes };
}
