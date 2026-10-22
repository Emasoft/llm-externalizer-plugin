/**
 * Candidate queue for the dynamic `free`/`paid` default profiles (design §2.4).
 *
 * The maintainer never writes a newly-discovered model id straight into
 * settings.yaml — an unbenchmarked model could be slow, non-compliant, or
 * (for paid) simply bad value. It queues the id here instead; the next
 * population sweep benchmarks `configured ∪ queued` and only THEN writes
 * survivors through pick.ts's writers. This file owns the queue only —
 * it never mutates settings.yaml.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir, loadSettings, resolveGroups, type DynamicProfileName, type ResolvedRoute } from "./config.js";
import { withMkdirLock } from "./mkdir-lock.js";

export interface CandidateEntry {
  id: string;
  queuedAt: number;
}

export interface CandidateQueue {
  version: 1;
  free: CandidateEntry[];
  paid: CandidateEntry[];
  // TRDD-C9SXX7HO: `local` never queues a candidate (there is no catalog
  // benchmark to defer it to) — present only so `CandidateQueue` stays
  // indexable by the full `DynamicProfileName` union in enqueueCandidates/
  // clearCandidates. Always empty in practice.
  local: CandidateEntry[];
}

const EMPTY_QUEUE: CandidateQueue = { version: 1, free: [], paid: [], local: [] };

export function candidateQueuePath(): string {
  return join(getConfigDir(), "dynamic-candidates.json");
}

/** Read the queue. Never throws on file/parse corruption (a missing or
 *  corrupt queue file is treated as empty — fail-open, the maintainer just
 *  re-discovers candidates next run — with one stderr line so that specific
 *  corruption is not silent).
 *
 *  `routesFor` is REQUIRED (3c/3e, review of 51a100c + 93cc031; D6a changed
 *  the shape from a first-binding-wins Map to the full serving-group lookup):
 *  the former tri-state (`undefined` -> re-derive from a fresh `loadSettings()`
 *  disk read, `null` -> skip pruning outright, a map -> prune against it)
 *  was a hidden opt-out — any call site that forgot to pass its own lookup
 *  silently fell back to a SECOND, possibly-stale settings read, and any
 *  call site (or future one) that passed `null` silently re-enabled
 *  fix-queue row 82's exact bug (every b.ai catalog id, not just the routed
 *  one, surviving in the queue forever). Every caller must now resolve and
 *  hand in its OWN routesFor — one source of settings, no silent "couldn't
 *  tell, so I let it through" path left inside this function at all. */
export function readCandidates(routesFor: (modelId: string) => ResolvedRoute[]): CandidateQueue {
  const path = candidateQueuePath();
  // TRDD-C9SXX7HO: `local` is never persisted to this queue (no catalog
  // benchmark ever defers a local id) — every returned queue carries an
  // always-empty `local: []` purely for CandidateQueue's shape.
  if (!existsSync(path)) return { version: 1, free: [], paid: [], local: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as CandidateQueue).free) ||
      !Array.isArray((parsed as CandidateQueue).paid)
    ) {
      process.stderr.write(`llm-ext: ${path} has an unexpected shape — treating the candidate queue as empty.\n`);
      return { version: 1, free: [], paid: [], local: [] };
    }
    const q = parsed as CandidateQueue;
    const free = q.free.filter((e) => e && typeof e.id === "string");
    const paid = q.paid.filter((e) => e && typeof e.id === "string");
    // Fix-queue row 95e/96(2): `local` is always empty BY DESIGN (no catalog
    // benchmark ever defers a local id). Before this fix a non-array `local`
    // (e.g. a string or object written by a bad future migration) slipped
    // through silently — only a non-empty ARRAY was reported. Widen the
    // condition to "present and (not an array, or a non-empty array)" so
    // every shape of stray data is loud, and fix the plural agreement
    // ("1 entries" was grammatically wrong) while we are in here.
    if (q.local !== undefined && (!Array.isArray(q.local) || q.local.length > 0)) {
      const detail = Array.isArray(q.local)
        ? `${q.local.length} ${q.local.length === 1 ? "entry" : "entries"}`
        : "a non-array value";
      process.stderr.write(
        `llm-ext: ${path}: local never queues candidates; ignoring ${detail}.\n`,
      );
    }
    return {
      version: 1,
      free: pruneUnroutedFreeCandidates(free, routesFor),
      paid,
      local: [],
    };
  } catch (err) {
    process.stderr.write(`llm-ext: ${path} is corrupt (${(err as Error).message}) — treating the candidate queue as empty.\n`);
    return { version: 1, free: [], paid: [], local: [] };
  }
}

/**
 * TRDD-38QAM06E queue hygiene: a candidate legally belongs in the `free`
 * queue only when it is either ':free'-suffixed (OpenRouter's own free-tier
 * marker, verified against the live catalog downstream) or bound to a
 * non-billable `providers[]` route on the current `free` profile
 * (`ApiPreset.isFreeProvider` — e.g. b.ai's glm-5.3-flash). Fix-queue row 82's
 * root cause (default-profiles.ts, fixed separately) queued every b.ai
 * catalog id instead of only the routed one, so a machine that hit that bug
 * before the fix landed still carries the stray ids on disk — this is the
 * migration: the read path prunes them going forward instead of a one-off
 * script, so every reader (populator, `settings status`, `queue list`) sees a
 * clean queue without a separate repair step.
 *
 * `routesFor` is the caller's own routing (see readCandidates' docstring
 * for who supplies it and why) — D6a: an id survives when ANY group serving
 * it is a free provider (two accounts of one free provider = still free).
 */
function pruneUnroutedFreeCandidates(
  entries: CandidateEntry[],
  routesFor: (modelId: string) => ResolvedRoute[],
): CandidateEntry[] {
  const kept: CandidateEntry[] = [];
  let dropped = 0;
  for (const e of entries) {
    if (e.id.endsWith(":free") || routesFor(e.id).some((r) => r.isFreeProvider === true)) {
      kept.push(e);
    } else {
      dropped++;
    }
  }
  if (dropped > 0) {
    process.stderr.write(
      `llm-ext: dropped ${dropped} stray unrouted 'free' candidate id(s) (no ':free' suffix, no free provider route) from ${candidateQueuePath()}.\n`,
    );
  }
  return kept;
}

function writeQueueAtomic(queue: CandidateQueue): void {
  const path = candidateQueuePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(queue, null, 2), "utf-8");
  renameSync(tmp, path);
}

function queueLockPath(): string {
  return join(getConfigDir(), "dynamic-candidates.lock");
}

/**
 * P6b-fix2 S-4 / N-3: both mutators below read → modify → write, and the PARENT
 * (the maintainer, enqueueing) and a benchmark CHILD (clearing the ids it just
 * judged) do it concurrently by design. Unlocked, the child's clear could be
 * written back out by the parent's enqueue — the judged ids returning to the
 * queue forever. The read now happens under the same lock as the write, which
 * is the only thing that makes "everything else in the queue is left
 * untouched" true across processes.
 */
/** enqueueCandidates/clearCandidates have no ResolvedProfile of their own to
 *  thread through (they're called from many sites — the maintainer, the
 *  populator's post-sweep judgment — most of which are mutating, not
 *  reading, and don't have a routesFor in hand). This derives one from
 *  the CURRENT `free` profile on disk, visibly, at the one place that still
 *  needs a default — never inside readCandidates itself (3c/3e review). */
function currentFreeRoutesFor(): (modelId: string) => ResolvedRoute[] {
  const freeProfile = loadSettings()?.profiles?.free;
  return freeProfile ? resolveGroups(freeProfile).routesFor : () => [];
}

function updateQueue(mutate: (queue: CandidateQueue) => CandidateQueue): CandidateQueue {
  return withMkdirLock(queueLockPath(), () => {
    const next = mutate(readCandidates(currentFreeRoutesFor()));
    writeQueueAtomic(next);
    return next;
  });
}

/** Append ids to a profile's queue, deduping by id (an already-queued id keeps
 *  its original `queuedAt`; re-enqueueing does not restart its wait). */
export function enqueueCandidates(profile: DynamicProfileName, ids: readonly string[], nowMs: number = Date.now()): CandidateQueue {
  return updateQueue((queue) => {
    const existing = new Set(queue[profile].map((e) => e.id));
    const additions = ids.filter((id) => !existing.has(id));
    return {
      ...EMPTY_QUEUE,
      ...queue,
      [profile]: [...queue[profile], ...additions.map((id) => ({ id, queuedAt: nowMs }))],
    };
  });
}

/** Remove exactly the given ids from a profile's queue (the ids a sweep just
 *  judged) — everything else in the queue is left untouched. */
export function clearCandidates(profile: DynamicProfileName, ids: readonly string[]): CandidateQueue {
  const remove = new Set(ids);
  return updateQueue((queue) => ({
    ...EMPTY_QUEUE,
    ...queue,
    [profile]: queue[profile].filter((e) => !remove.has(e.id)),
  }));
}