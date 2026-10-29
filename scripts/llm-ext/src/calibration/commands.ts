/**
 * calibration/commands.ts — `llm-ext models calibrate` and `llm-ext models
 * calibration-status` (P6; spec section 8).
 */

import { existsSync } from "node:fs";
import type { Profile } from "../config.js";
import { readRecord } from "./record.js";
import { liveCalibrator, METHOD_PHASES } from "./runner.js";
import { loadProgress, progressPath, readQueue, enqueueUnlocked, withStateLock } from "./state.js";
import { managedProfileModels } from "./triggers.js";
import type { BrokerEngine } from "../broker/protocol.js";

/** The managed profiles naming `model`, and the engine they serve it with (refused when two disagree). */
export function engineOf(profiles: Readonly<Record<string, Profile>>, model: string): { engine: BrokerEngine; profiles: string[] } | { error: string } {
  const named = Object.entries(managedProfileModels(profiles)).filter(([, p]) => p.models.includes(model));
  if (named.length === 0) return { error: `no managed local profile (server: managed, api llamacpp-local or locals-local) names the model '${model}'; add it to a profile first` };
  const engines = [...new Set(named.map(([, p]) => p.engine))];
  if (engines.length > 1) return { error: `the model '${model}' is named by profiles of both engines (${named.map(([n]) => n).join(", ")}); calibration needs one engine` };
  return { engine: engines[0], profiles: named.map(([n]) => n) };
}

/** Trigger 3: queue the model (force = even with a valid record), then the caller starts the runner. */
export function queueManual(dir: string, profiles: Readonly<Record<string, Profile>>, model: string, force: boolean): { engine: BrokerEngine; text: string } | { error: string } {
  const e = engineOf(profiles, model);
  if ("error" in e) return e;
  const r = readRecord(dir, e.engine, model);
  if (r && !force) return { error: `'${model}' already has a calibration record (${r.status}, ${r.calibrated_at}); pass --force to calibrate it again` };
  const done = withStateLock(dir, 30_000, () => {
    enqueueUnlocked(dir, { engine: e.engine, model, reason: "manual", force });
    return true;
  });
  if (done === undefined) return { error: "the calibration state lock stayed busy for 30 s; try again" };
  return { engine: e.engine, text: `queued '${model}' (${e.engine}, profiles ${e.profiles.join(", ")}) for calibration${force ? " (--force)" : ""}` };
}

/** One line per managed model: its record status, or its progress and queue state; plus the runner. */
export async function calibrationStatusText(dir: string, profiles: Readonly<Record<string, Profile>>): Promise<string> {
  const lines: string[] = [];
  const runner = await liveCalibrator(dir);
  lines.push(runner ? `calibration runner: pid ${runner.pid} (version ${runner.version}, since ${runner.startedAt})` : "calibration runner: not running");
  const queue = readQueue(dir);
  const seen = new Set<string>();
  for (const [name, p] of Object.entries(managedProfileModels(profiles))) {
    for (const model of p.models) {
      const key = `${p.engine}\u0000${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = readRecord(dir, p.engine, model);
      let state: string;
      if (r) state = r.status === "ok" ? `calibrated ${r.calibrated_at}` : `${r.status} at ${r.failed_step ?? "?"}: ${r.message ?? ""}`;
      else {
        const prog = existsSync(progressPath(dir, p.engine, model)) ? loadProgress(dir, p.engine, model, null) : null;
        const phases = prog ? METHOD_PHASES.map((ph) => `${ph} ${prog.phases[ph] ?? "pending"}`).join(", ") : "not started";
        const queued = queue.some((q) => q.engine === p.engine && q.model === model);
        state = `not calibrated (${phases}; ${prog ? prog.trials.length : 0} trials${queued ? "; queued" : ""})`;
        // Spec 4.2 (F16): a model whose thinking cannot be turned on is reported, never silently.
        const a = prog?.trials.find((t) => t.step === "A/summary")?.data;
        if (a) state += `; Phase A: thinking off ${a.thinking_off} on ${a.thinking_on}, json_schema off ${a.json_off} on ${a.json_on} array40 ${a.array40}, decode ${a.decode_tps} tok/s`;
        if (a?.thinking_on === false) state += "; thinking cannot be turned on: the bug kind runs with thinking off";
      }
      lines.push(`${name} ${p.engine} '${model}': ${state}`);
    }
  }
  if (seen.size === 0) lines.push("no managed local profile in settings.yaml");
  return lines.join("\n");
}
