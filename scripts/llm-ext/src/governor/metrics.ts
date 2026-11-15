/**
 * governor/metrics.ts — the system readings the local-inference governor acts
 * on (design/specs/local-inference-governor-design.md D4).
 *
 * CPU is the share of all logical cores busy, from two os.cpus() samples. The
 * counters are machine-wide, so the earlier sample may come from another
 * process: it lives in the shared state and the next sampler computes the
 * delta at once. os.loadavg is never used: it was 99 while utilisation was 82.
 *
 * RAM has one definition of "used", governor/ram.ts (round 3, D4), shared with
 * calibration through memoryFreePercent, so on darwin the governor and
 * calibration read the same figure. Elsewhere they still differ: calibration's
 * freeMemory uses os.freemem() off darwin, while readRam reads /proc/meminfo
 * on Linux (MemTotal minus MemAvailable).
 */

import { cpus } from "node:os";
import { readRam } from "./ram.js";

/** Cumulative busy and total CPU time of all cores at one instant. */
export interface CpuSample {
  at: number;
  busyMs: number;
  totalMs: number;
}

/** The shared reading. `at` moves only when both figures are current, so an age check on it covers both. */
export interface Metrics {
  at: number;
  cpuSample: CpuSample | null;
  cpuPct: number | null;
  freePct: number | null;
}

export interface MemoryReading {
  freePct: number;
  usedPct: number;
}

/** A delta over less than this is mostly tick noise (D4). */
export const MIN_CPU_GAP_MS = 500;
/** A stored sample older than this says nothing about now (D4). */
export const MAX_CPU_GAP_MS = 10_000;
/** The head samples at most this often: one vm_stat a second, machine-wide (D7). */
export const READING_INTERVAL_MS = 1_000;

export function coreCount(): number {
  return cpus().length;
}
export function emptyMetrics(): Metrics {
  return { at: 0, cpuSample: null, cpuPct: null, freePct: null };
}

export function sampleCpu(now: number): CpuSample {
  let busyMs = 0;
  let totalMs = 0;
  for (const { times } of cpus()) {
    const total = times.user + times.nice + times.sys + times.irq + times.idle;
    totalMs += total;
    busyMs += total - times.idle;
  }
  return { at: now, busyMs, totalMs };
}

/** Percent of all cores busy between two samples. */
export function cpuBusyPercent(prev: CpuSample, next: CpuSample): number {
  const total = next.totalMs - prev.totalMs;
  // Some sandboxes report all-zero counters. A NaN here would serialize as null and read as a stale metric, a silent hang.
  if (!(total > 0)) throw new Error("os.cpus() gave no usable CPU counters: the governor cannot measure this machine");
  return (100 * (next.busyMs - prev.busyMs)) / total;
}

/** One RAM reading; usedPct is defined by freePct, so the two can never come from different instants. */
export async function readMemory(): Promise<MemoryReading> {
  const { usedBytes, totalBytes } = await readRam();
  const freePct = 100 - (100 * usedBytes) / totalBytes;
  return { freePct, usedPct: 100 - freePct };
}

/** Whether the head should take a new reading now. */
export function needsReading(m: Metrics, now: number): boolean {
  return now - m.at >= READING_INTERVAL_MS && (m.cpuSample === null || now - m.cpuSample.at >= MIN_CPU_GAP_MS);
}

/**
 * The metrics after one sample. A stored sample in the usable age band gives a
 * CPU figure at once; otherwise this sample is stored and `at` stays put, so
 * the reading counts as stale until the next one completes it. The value is
 * smoothed once, and never with a figure too old to describe the same load.
 */
export function nextMetrics(m: Metrics, freePct: number, sample: CpuSample, now: number): Metrics {
  const prev = m.cpuSample;
  const age = prev === null ? Infinity : sample.at - prev.at;
  if (age < MIN_CPU_GAP_MS) return m;
  if (prev === null || age > MAX_CPU_GAP_MS) return { ...m, cpuSample: sample, freePct };
  const raw = cpuBusyPercent(prev, sample);
  const cpuPct = m.cpuPct !== null && now - m.at <= MAX_CPU_GAP_MS ? 0.5 * m.cpuPct + 0.5 * raw : raw;
  return { at: now, cpuSample: sample, cpuPct, freePct };
}
