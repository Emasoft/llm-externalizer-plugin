// SP-22 (TRDD-DTDGVXWV): runs the extract command's caller-supplied regexes off the main thread with a hard deadline (plan §9 `classify extract`, §12 E64).
// Ported behaviour: jev-mcp runRegex (src/lib.ts REGEX_WORKER_SOURCE and runRegex; MIT, SEC-01 commit 86eae78): worker thread, terminate on deadline, zero-length matches dropped,
// over-long matches counted and skipped before the cap, g forced once. Code and wording are our own (D17). Differences: one worker serves all fields of a call (a fresh one only after a timeout),
// over-long matches are counted per occurrence (never kept), the heap of a worker is capped, and one call has a total time budget.
// The promise REJECTS only for programming errors (bad cap or timeouts) and when a worker cannot be constructed at all (for example Node's permission model without worker permission);
// a bad pattern, bad flags, a timeout, an abort or a crashed worker are per-field error results. The caller cuts the text first (extract.ts `cutDocument`); this module runs on exactly the string it is given.
import { Worker, type WorkerOptions } from "node:worker_threads";

/** A single match longer than this is skipped by the worker and counted, never cut. */
export const MAX_CANDIDATE_CHARS = 2_000;
/** Hard per-field deadline of one regex (jev-mcp REGEX_TIMEOUT_MS). */
export const REGEX_TIMEOUT_MS = 1_000;
/** A worker that is not online after this long is given up on (a hung start would otherwise pend forever). */
export const WORKER_START_MS = 5_000;
// WHY 5 s: the plan's candidate ceiling is 32 fields; at 1 s each, 32 hanging patterns would hold the CLI for 32 s. Five seconds is a few failed fields plus normal work, and a call with fewer than five fields keeps its full fields x timeout.
const TOTAL_BUDGET_CAP_MS = 5_000;
// WHY a heap cap: a backstop against a pattern that exhausts memory instead of time; the text is at most ~50k chars and at most `cap` strings are kept, so 128 MB is far above any honest run.
const WORKER_HEAP_MB = 128;

export interface RegexResult {
  candidates: string[];
  /** Line mode only: 1-based ascending numbers of the matching lines; absent in string mode and in every error result. */
  lines?: number[];
  truncated: boolean;
  tooLong: number;
  error: string | null;
}
export interface RegexField {
  pattern: string;
  flags: string;
  /** Report matching line numbers instead of matched strings (see WORKER_SOURCE). */
  lines?: boolean;
}
/** How a worker is made; the default is the real `new Worker`. Test seam only (a worker that never starts, one that errors late). */
export type SpawnWorker = (source: string, options: WorkerOptions) => Worker;
export interface RegexOptions {
  signal?: AbortSignal;
  /** Per-field deadline; default REGEX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Total time for the whole call; default min(fields x timeoutMs, 5000). Fields not started by then get the budget error. */
  totalMs?: number;
  /** Deadline for a worker to come online; default WORKER_START_MS. */
  startupMs?: number;
  spawn?: SpawnWorker;
}

const failed = (error: string): RegexResult => ({ candidates: [], truncated: false, tooLong: 0, error });
export const BUDGET_ERROR = "regex budget for this call exhausted";

// WHY a constant string run with eval: dist/llm-ext.js is ONE bundled file, so a worker started from a file path would not exist next to it; an inline source needs no imports but node builtins and survives bundling.
// SECURITY: this source never contains caller data. The text, cap and limit enter as workerData; each pattern and flags value as a posted message, and reach only `new RegExp`.
// Written as joined lines (not a template) so no backtick or dollar-brace can ever be spliced in.
// WHY matchAll and stop at the cap: it advances past an empty match by itself (no endless loop), is lazy, and a run that has `cap` distinct candidates plus one more stops collecting at once.
// WHY line mode in the same source: it must share the worker thread, deadline, cap and abort path of string mode; a second worker path would drift. Lines are split exactly as test-output.ts splitLines (split on \n, a \r before it stripped, the empty piece after a final newline dropped) so the numbers are valid `matches`.
// WHY a line longer than maxChars is cut to maxChars before the test and counted in tooLong: the same cap as a candidate, so one huge line cannot make a pattern run unbounded; a match beyond the cut is not seen.
const WORKER_SOURCE = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  "const { text, cap, maxChars } = workerData;",
  'parentPort.on("message", (m) => {',
  "  try {",
  "    const re = new RegExp(m.pattern, m.flags);",
  "    let truncated = false;",
  "    let tooLong = 0;",
  "    if (m.lines) {",
  "      const all = text.split(/\\r?\\n/);",
  '      if (all.at(-1) === "") all.pop();',
  "      const lines = [];",
  "      for (let k = 0; k < all.length; k++) {",
  "        let l = all[k];",
  "        if (l.length > maxChars) { tooLong++; l = l.slice(0, maxChars); }",
  "        re.lastIndex = 0;",
  "        if (!re.test(l)) continue;",
  "        if (lines.length >= cap) { truncated = true; break; }",
  "        lines.push(k + 1);",
  "      }",
  '      parentPort.postMessage({ candidates: [], lines, truncated, tooLong, error: null });',
  "      return;",
  "    }",
  "    const seen = new Set();",
  "    const candidates = [];",
  "    for (const match of text.matchAll(re)) {",
  "      const v = match[0];",
  "      if (v.length === 0) continue;",
  "      if (v.length > maxChars) { tooLong++; continue; }",
  "      if (seen.has(v)) continue;",
  "      if (candidates.length >= cap) { truncated = true; break; }",
  "      seen.add(v);",
  "      candidates.push(v);",
  "    }",
  "    parentPort.postMessage({ candidates, truncated, tooLong, error: null });",
  "  } catch (e) {",
  '    parentPort.postMessage({ candidates: [], truncated: false, tooLong: 0, error: String(e && e.message ? e.message : e) || "regex failed" });',
  "  }",
  "});",
].join("\n");

// One live worker. `run` handles one field at a time; after a timeout, an abort or a crash the worker is `dead` and the caller must `kill` it and start another.
class Live {
  private readonly worker: Worker;
  private readonly exited: Promise<void>;
  private online = false;
  dead = false;
  constructor(text: string, cap: number, spawn: SpawnWorker) {
    this.worker = spawn(WORKER_SOURCE, { eval: true, workerData: { text, cap, maxChars: MAX_CANDIDATE_CHARS }, resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    this.exited = new Promise((r) => this.worker.once("exit", () => r()));
    this.worker.once("online", () => { this.online = true; });
    // WHY permanent listeners: a run removes its own `error` listener when it settles, and an `error` event with no listener is an uncaught exception that kills the CLI. A worker can still fail after that
    // (the heap limit hit while being terminated, a crash between two fields), and a worker that exited on its own between two fields must not be handed the next field. They only mark the worker dead.
    this.worker.on("error", () => { this.dead = true; });
    this.worker.on("exit", () => { this.dead = true; });
  }
  run(f: RegexField, timeoutMs: number, startupMs: number, signal: AbortSignal | undefined): Promise<RegexResult> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (r: RegexResult, dead: boolean): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
        this.worker.off("online", start);
        if (dead) this.dead = true;
        resolve(r);
      };
      const onMessage = (m: RegexResult): void => done(m, false);
      const onError = (e: Error): void => done(failed(e.message || "regex worker failed"), true);
      const onExit = (code: number): void => done(failed(`regex worker exited with code ${code}`), true);
      const onAbort = (): void => done(failed("aborted"), true);
      // WHY the field deadline starts when the worker is online: thread start-up must not eat the first field's time. WHY a separate start-up deadline: a worker that never comes online would otherwise pend forever.
      // WHY `lines` is posted with every field: the worker picks line mode per message, so string and line fields share one worker, one deadline and one abort path.
      const start = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => done(failed(`regex timed out after ${timeoutMs}ms`), true), timeoutMs);
        this.worker.postMessage({ pattern: f.pattern, flags: f.flags, lines: f.lines === true });
      };
      this.worker.on("message", onMessage);
      this.worker.on("error", onError);
      this.worker.on("exit", onExit);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.online) start();
      else {
        timer = setTimeout(() => done(failed("regex worker did not start"), true), startupMs);
        this.worker.once("online", start);
      }
    });
  }
  // WHY await the exit: terminate() only requests the stop; resolving before the thread is gone would leak it past the caller (and past the end of a test).
  async kill(): Promise<void> {
    await this.worker.terminate();
    await this.exited;
  }
}

/**
 * Runs each field's regex on `text`, in order, in ONE worker thread, each field under its own deadline and the whole call under a total budget.
 * A field that times out (or a crash) ends as `error` with no candidates, the worker is terminated and a fresh one serves the remaining fields.
 * Never throws for a bad pattern or flags; rejects with RangeError for a bad `cap` or time (programming errors) and with whatever the worker constructor throws.
 * Flags must be letters only (anything else is an error result: the user's flags are never silently rewritten); every g is removed and exactly one g appended; an unknown letter is the engine's error.
 * Sticky (y) is passed through: the engine then matches only back to back from index 0.
 */
export async function runRegexes(text: string, fields: readonly RegexField[], cap: number, opts: RegexOptions = {}): Promise<RegexResult[]> {
  const timeoutMs = opts.timeoutMs ?? REGEX_TIMEOUT_MS;
  // WHY max with one field's time: even an empty or one-field call keeps its full per-field deadline.
  const totalMs = opts.totalMs ?? Math.max(timeoutMs, Math.min(fields.length * timeoutMs, TOTAL_BUDGET_CAP_MS));
  const startupMs = opts.startupMs ?? WORKER_START_MS;
  const spawn = opts.spawn ?? ((s, o) => new Worker(s, o));
  if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`regex cap must be a whole number of at least 1, got ${cap}`);
  if (!(timeoutMs > 0) || !(totalMs > 0) || !(startupMs > 0)) throw new RangeError(`regex timeouts must be positive, got ${timeoutMs}, ${totalMs}, ${startupMs}`);
  const out: RegexResult[] = [];
  const t0 = Date.now();
  let live: Live | null = null;
  try {
    for (const f of fields) {
      if (opts.signal?.aborted) { out.push(failed("aborted")); continue; }
      if (Date.now() - t0 >= totalMs) { out.push(failed(BUDGET_ERROR)); continue; }
      if (!/^[a-zA-Z]*$/.test(f.flags)) { out.push(failed(`invalid flags: ${JSON.stringify(f.flags)} (letters only)`)); continue; }
      // WHY check here and only here: a timeout, abort or crash of the last run, or the permanent exit/error listeners, mark the worker dead; it is killed and replaced before the next field, and the final one by `finally`.
      if (live?.dead) {
        await live.kill();
        live = null;
      }
      live ??= new Live(text, cap, spawn);
      // WHY the g rewrite (jev-mcp): "gi" must not become "gig", which would throw; matchAll requires g.
      const flags = f.flags.replace(/g/g, "") + "g";
      out.push(await live.run({ pattern: f.pattern, flags, lines: f.lines }, timeoutMs, startupMs, opts.signal));
    }
  } finally {
    if (live) await live.kill();
  }
  return out;
}

/** One regex over `text`; see runRegexes. `extra` carries the seam and the other deadlines. */
export async function runRegex(text: string, pattern: string, flags: string, cap: number, signal?: AbortSignal, timeoutMs?: number, extra: Omit<RegexOptions, "signal" | "timeoutMs"> = {}): Promise<RegexResult> {
  return (await runRegexes(text, [{ pattern, flags }], cap, { ...extra, signal, timeoutMs }))[0]!;
}


/** One regex over the LINES of `text`: 1-based ascending numbers of matching lines in `lines` (capped at `cap`, `truncated` when more exist). Same worker, deadlines, caps and abort as runRegex. */
export async function runRegexLines(text: string, pattern: string, flags: string, cap: number, signal?: AbortSignal, timeoutMs?: number, extra: Omit<RegexOptions, "signal" | "timeoutMs"> = {}): Promise<RegexResult> {
  return (await runRegexes(text, [{ pattern, flags, lines: true }], cap, { ...extra, signal, timeoutMs }))[0]!;
}
