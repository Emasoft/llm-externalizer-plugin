/**
 * calibration/triggers.ts — when calibration starts (P6; spec section 3,
 * ruling L73): (1) a held job, in the broker; (2) a model the user adds or
 * changes in a managed local profile that has been used, checked at boot
 * here; (3) `llm-ext models calibrate`. Never on boot for a profile nobody
 * used, so the add-once built-in profiles cost nothing until used.
 */

import type { BrokerEngine } from "../broker/protocol.js";
import type { Profile } from "../config.js";
import { dequeueUnlocked, enqueueUnlocked, readQueue, readSeenModels, withStateLock, writeSeenModelsUnlocked, type QueueItem } from "./state.js";

/** The boot check waits this long for the state lock, then skips itself for this run: it must never block or fail a command. */
const BOOT_LOCK_WAIT_MS = 1500;

export interface ManagedProfileModels {
  engine: BrokerEngine;
  /** model, second_model, third_model, in that order, without blanks. */
  models: string[];
}

/** The managed local profiles (server: managed, llamacpp-local or locals-local) and their model ids. */
export function managedProfileModels(profiles: Readonly<Record<string, Profile>>): Record<string, ManagedProfileModels> {
  const out: Record<string, ManagedProfileModels> = {};
  for (const [name, p] of Object.entries(profiles)) {
    if (p.server !== "managed" || (p.api !== "llamacpp-local" && p.api !== "locals-local")) continue;
    const models = [p.model, p.second_model, p.third_model].filter((m): m is string => typeof m === "string" && m !== "");
    out[name] = { engine: p.api === "locals-local" ? "locals" : "llama", models };
  }
  return out;
}

/**
 * Trigger 2. Compares the managed profiles' model ids with
 * seen-models.json; a new or changed id in a USED profile is queued. The
 * first boot only writes the file. seen-models is rewritten only when the ids
 * changed. Returns the queued items ([] also when the lock was busy).
 */
export function checkModelChanges(dir: string, profiles: Readonly<Record<string, Profile>>): Array<Pick<QueueItem, "engine" | "model">> {
  const current = managedProfileModels(profiles);
  const ids = Object.fromEntries(Object.entries(current).map(([n, p]) => [n, p.models]));
  const queued =
    withStateLock(dir, BOOT_LOCK_WAIT_MS, () => {
      const seen = readSeenModels(dir);
      if (seen === null) {
        writeSeenModelsUnlocked(dir, { profiles: ids, used_profiles: [] });
        return [];
      }
      const out: Array<Pick<QueueItem, "engine" | "model">> = [];
      for (const [name, p] of Object.entries(current)) {
        if (!seen.used_profiles.includes(name)) continue;
        const before = new Set(seen.profiles[name] ?? []);
        for (const m of p.models) {
          if (before.has(m)) continue;
          enqueueUnlocked(dir, { engine: p.engine, model: m, reason: "model-change" });
          out.push({ engine: p.engine, model: m });
        }
      }
      if (JSON.stringify(seen.profiles) !== JSON.stringify(ids)) writeSeenModelsUnlocked(dir, { profiles: ids, used_profiles: seen.used_profiles });
      // Review M6: a queued model no managed profile names any more (its profile was deleted or edited) is dropped,
      // so the runner never spends hours on it. A manual item was checked against the profiles when it was queued.
      const named = new Set(Object.values(current).flatMap((p) => p.models.map((m) => `${p.engine}\u0000${m}`)));
      for (const q of readQueue(dir)) if (q.reason !== "manual" && !named.has(`${q.engine}\u0000${q.model}`)) dequeueUnlocked(dir, q.engine, q.model);
      return out;
    }) ?? [];
  return queued;
}

/** Profiles this process already marked as used (one state-file write per profile per process). */
const markedUsed = new Set<string>();

/** Record that `name` sent a request through the broker (trigger 2 then watches its model ids). Best effort: a busy lock retries on the next request. */
export function markProfileUsed(dir: string, name: string, profiles: Readonly<Record<string, Profile>>): void {
  const key = `${dir}\u0000${name}`;
  if (markedUsed.has(key)) return;
  const done = withStateLock(dir, BOOT_LOCK_WAIT_MS, () => {
    const seen = readSeenModels(dir) ?? { profiles: {}, used_profiles: [] };
    if (seen.used_profiles.includes(name)) return true;
    const models = managedProfileModels(profiles)[name]?.models;
    writeSeenModelsUnlocked(dir, { profiles: models ? { ...seen.profiles, [name]: models } : seen.profiles, used_profiles: [...seen.used_profiles, name] });
    return true;
  });
  if (done !== undefined) markedUsed.add(key);
}
