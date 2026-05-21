// Pre-flight model verification gate (Q11 from TRDD-220ea89f). Runs a
// tiny "group these 3 sentences" benchmark against the active profile
// BEFORE the cluster_synonyms tool spends any clustering budget. If the
// model cannot produce valid structured JSON, the run aborts with a
// clear "fix your profile" message — separating model bugs from prompt
// bugs in failure triage.
//
// Cached per-profile-per-day at:
//   ~/.llm-externalizer/cache/benchmark-<profile-hash>-<YYYY-MM-DD>.json
// Same-day re-runs skip the LLM call entirely.
//
// The LLM call itself is injected as a callback so this module is
// trivially unit-testable with a mock. Phase B wires the real
// processBatch / callLLM from index.ts.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export const DEFAULT_PREFLIGHT_PROMPT = `You are given 3 short sentences with numeric ids. Group sentences that have IDENTICAL or NEARLY-IDENTICAL overall meaning (full-sentence meaning equivalence, NOT word-by-word synonym matching).

Output: a JSON object {"groups": [[id, id, ...], [id], ...]}.
Every input id MUST appear exactly once across all groups.

Sentences:
1. id=1 sentence="The cat sat on the mat"
2. id=2 sentence="A feline rested on the rug"
3. id=3 sentence="The sun is bright today"`;

export const ResponseSchema = z.object({
  groups: z.array(z.array(z.number().int())),
});

export type PreflightLlmFn = (prompt: string) => Promise<string>;

export interface PreflightOk {
  pass: true;
  cached: boolean;
  cache_path: string;
  date: string;
  timestamp: number;
}
export interface PreflightFail {
  pass: false;
  cached: boolean;
  cache_path: string;
  reason: string;
  raw_response?: string;
}
export type PreflightResult = PreflightOk | PreflightFail;

export interface PreflightOpts {
  cacheDir?: string;
  force?: boolean;
  /** Test override — defaults to today's local date in YYYY-MM-DD. */
  today?: string;
}

interface CacheRecord {
  version: 1;
  profile_hash: string;
  date: string;
  timestamp: number;
  pass: boolean;
  reason: string | null;
  raw_response: string | null;
}

export function profileHash(profileFingerprint: string): string {
  return createHash("sha256").update(profileFingerprint).digest("hex").slice(0, 16);
}

function defaultCacheDir(): string {
  return join(homedir(), ".llm-externalizer", "cache");
}

function todayLocalISO(): string {
  // YYYY-MM-DD in the local timezone — matches user expectations from
  // ~/.claude/rules/agent-reports-location.md (local time, not UTC).
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function cachePathFor(profileHashStr: string, date: string, cacheDir?: string): string {
  const dir = cacheDir ?? defaultCacheDir();
  return join(dir, `benchmark-${profileHashStr}-${date}.json`);
}

function readCache(path: string): CacheRecord | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as CacheRecord;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(path: string, rec: CacheRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", "utf8");
  // Atomic publish — POSIX rename is atomic on the same filesystem.
  renameSync(tmp, path);
}

/**
 * Validate a model's response to the pre-flight prompt. Returns null on
 * pass; the failure reason string otherwise. The schema gate is the
 * primary check; the semantic gate (items 1+2 in same group, item 3
 * alone) is a soft check that produces a WARNING but not a FAIL.
 */
export function validatePreflightResponse(
  raw: string,
): { pass: true } | { pass: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      pass: false,
      reason: `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = ResponseSchema.safeParse(parsed);
  if (!result.success) {
    return {
      pass: false,
      reason: `response does not match required {groups: number[][]} schema: ${result.error.message}`,
    };
  }
  // Soft semantic check: every id 1..3 must appear exactly once.
  const seen = new Set<number>();
  let total = 0;
  for (const grp of result.data.groups) {
    for (const id of grp) {
      seen.add(id);
      total++;
    }
  }
  if (seen.size !== 3 || total !== 3) {
    return {
      pass: false,
      reason: `response groups must contain each of ids 1,2,3 exactly once (got ${total} entries, ${seen.size} unique)`,
    };
  }
  if (!seen.has(1) || !seen.has(2) || !seen.has(3)) {
    return { pass: false, reason: "response groups missing one of the expected ids 1,2,3" };
  }
  return { pass: true };
}

/**
 * Run (or look up the cache for) the pre-flight benchmark for one
 * profile. The `profileFingerprint` is any string that uniquely
 * identifies the active profile (e.g. profile name + active model id)
 * so a profile switch invalidates the cache. The `llmCall` callback
 * is the actual model invocation — Phase B wires processBatch here.
 */
export async function runPreflightBenchmark(
  profileFingerprint: string,
  llmCall: PreflightLlmFn,
  opts: PreflightOpts = {},
): Promise<PreflightResult> {
  const ph = profileHash(profileFingerprint);
  const date = opts.today ?? todayLocalISO();
  const cp = cachePathFor(ph, date, opts.cacheDir);

  if (!opts.force) {
    const cached = readCache(cp);
    if (cached && cached.date === date && cached.profile_hash === ph) {
      if (cached.pass) {
        return {
          pass: true,
          cached: true,
          cache_path: cp,
          date,
          timestamp: cached.timestamp,
        };
      }
      return {
        pass: false,
        cached: true,
        cache_path: cp,
        reason: cached.reason ?? "(cached failure with no reason)",
        raw_response: cached.raw_response ?? undefined,
      };
    }
  }

  // Live benchmark call.
  let raw: string;
  try {
    raw = await llmCall(DEFAULT_PREFLIGHT_PROMPT);
  } catch (err) {
    const reason = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
    const rec: CacheRecord = {
      version: 1,
      profile_hash: ph,
      date,
      timestamp: Date.now(),
      pass: false,
      reason,
      raw_response: null,
    };
    writeCache(cp, rec);
    return { pass: false, cached: false, cache_path: cp, reason };
  }

  const v = validatePreflightResponse(raw);
  const ts = Date.now();
  const rec: CacheRecord = {
    version: 1,
    profile_hash: ph,
    date,
    timestamp: ts,
    pass: v.pass,
    reason: v.pass ? null : v.reason,
    raw_response: v.pass ? null : raw,
  };
  writeCache(cp, rec);

  if (v.pass) {
    return { pass: true, cached: false, cache_path: cp, date, timestamp: ts };
  }
  return { pass: false, cached: false, cache_path: cp, reason: v.reason, raw_response: raw };
}
