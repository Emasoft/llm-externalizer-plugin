/**
 * local-input-budget.ts: P7 of the local-profiles program (TRDD-1OOAH3LD, TRDD-ZGSGGHQG), input sizing from the
 * calibration record (design/specs/local-calibration-design.md section 6 and its "P7 as built" block).
 *
 * For a request of task kind k on a local llama.cpp or Locals model with an ok record R:
 *   window           = min(the context the route gives one request, R.window_tokens). The route's context is the
 *                      profile context_window C, or, on a managed route with C unset, the per-slot context the broker
 *                      starts the main server with (PROVISIONAL_LOCAL_CTX, passed in as LocalMember.ctx); an unmanaged
 *                      route with C unset: R.window_tokens alone.
 *   output_cap[k]    = the user request_options max_output_tokens when set (it wins), else
 *                      max(R.min_output_tokens[k], the nominal cap of the thinking mode k runs in)
 *   input_budget[k]  = min(R.fill_tokens[k], window - output_cap[k] - SLOT_OVERHEAD)
 *   bytes            = input_budget[k] x R.chars_per_token x CHARS_PER_TOKEN_SAFETY
 * Every model the command may send to (the profile head, its fallbacks and its ensemble members) is sized at once: ONE
 * output cap (the largest any of them needs) and ONE input budget (the smallest), because one batch goes to every
 * member and a fallback resends the same batch. The bytes cover the files AND the prompt of a request (index.ts
 * reserves the instructions and system prompt before injecting it), so input + output stay inside the window as far
 * as chars_per_token x CHARS_PER_TOKEN_SAFETY holds for the text sent.
 *
 * WHY chars_per_token and not /tokenize on llama: the budget is needed before any text exists, and on a managed
 * profile before the broker has started a server to ask; the record's chars_per_token was itself measured with
 * /tokenize on llama (Phase A, three probe documents). It is an average, hence the safety factor.
 */

import { readFileSync } from "node:fs";
import type { BrokerEngine } from "./broker/protocol.js";
import { CommandStoppedError } from "./command-stop.js";
import { CAP_OFF, CAP_ON } from "./calibration/phase-a.js";
// The prompt overhead Phase C reserves in every slot (spec 4.5); the input budget reserves the same.
import { SLOT_OVERHEAD } from "./calibration/phase-c.js";
import { readRecord, readRecordStatus, type CalibrationRecord, type TaskKind } from "./calibration/record.js";
import { progressPath } from "./calibration/state.js";

/** Spec 6: a budget below this fails the command at once (a context_window too small for the output cap). */
export const MIN_LOCAL_INPUT_TOKENS = 1024;
/** How often a command waiting for a calibration re-reads the record (the broker re-checks held jobs every 5 s too). */
export const CALIBRATION_POLL_MS = 5_000;
/** How often a waiting command queues the calibration again and makes sure a runner lives (a dead runner is restarted). */
export const CALIBRATION_RESTART_MS = 60_000;
/** How often a waiting command prints a progress line. */
export const CALIBRATION_PROGRESS_MS = 300_000;
/**
 * Safety factor on the record's chars_per_token (round 3, review M3). chars_per_token is an average over Phase A's three
 * probe documents (prose, code, JSON lines). Measured 2026-10-31 with /tokenize of the stories15M tiny llama (32000-token
 * llama vocabulary): probes 2.652 chars/token; a .ts file (src/local-input-budget.ts) 3.194 (ratio 1.205), a .json file
 * (scripts/llm-ext/package.json) 2.357 (ratio 0.889), a .md file (design/specs/local-calibration-design.md) 3.326 (ratio
 * 1.255). The worst ratio, 0.889, rounded down: real JSON packs more tokens per character than the probes do.
 */
export const CHARS_PER_TOKEN_SAFETY = 0.88;

/**
 * The command-to-task-kind table (spec 1: P7 owns it). `sizesInput`: the command caps its input by max_payload_kb, so
 * the calibrated budget is injected there; the others get only the calibrated max_tokens. `filesPerRequest`: how many
 * budget-sized file blocks one request of the command can carry where max_payload_kb is a PER-FILE limit (compare_files
 * sends both files and their diff, about 2 x (A + B), so 4; check_against_specs the spec and one file, so 2); check_references, whose dependencies are unbounded in
 * number, gets a total cap in index.ts instead. fact = retrieval and editing, thinking off; aggregate = combining the
 * whole input, thinking off; bug = analysis, thinking on. mass_scout is not here: it sizes by the record's scouting
 * shape (P9).
 */
export const TASK_KIND_BY_TOOL: Readonly<Record<string, { kind: TaskKind; sizesInput: boolean; filesPerRequest?: number }>> = {
  chat: { kind: "fact", sizesInput: true },
  describe: { kind: "fact", sizesInput: false },
  scan_folder: { kind: "fact", sizesInput: true },
  // batch_check: the per-file form of chat (instructions over each file), so it is chat's kind.
  batch_check: { kind: "fact", sizesInput: true },
  summarize: { kind: "aggregate", sizesInput: false },
  topics: { kind: "aggregate", sizesInput: false },
  cluster_synonyms: { kind: "aggregate", sizesInput: false },
  sem_deduplicate: { kind: "aggregate", sizesInput: false },
  session_summary: { kind: "aggregate", sizesInput: false },
  security_scan: { kind: "bug", sizesInput: false },
  high_quality_scan: { kind: "bug", sizesInput: true },
  search_existing_implementations: { kind: "bug", sizesInput: true },
  check_imports: { kind: "bug", sizesInput: true },
  check_references: { kind: "bug", sizesInput: true },
  check_against_specs: { kind: "bug", sizesInput: true, filesPerRequest: 2 },
  rules_check: { kind: "bug", sizesInput: false },
  review_plan: { kind: "bug", sizesInput: false },
  compare_files: { kind: "bug", sizesInput: true, filesPerRequest: 4 },
  code_task: { kind: "bug", sizesInput: true },
};

/** The table entry of `tool`, own keys only: a tool named like an Object.prototype member ("constructor") is not classified. */
export function taskEntryOf(tool: string): (typeof TASK_KIND_BY_TOOL)[string] | undefined {
  return Object.hasOwn(TASK_KIND_BY_TOOL, tool) ? TASK_KIND_BY_TOOL[tool] : undefined;
}

/** The engine whose calibration records describe a route of this api preset; null for any other local or remote api. */
export function localEngineOf(api: string): BrokerEngine | null {
  if (api === "llamacpp-local") return "llama";
  if (api === "locals-local") return "locals";
  return null;
}

/**
 * One model a command may send to: its id, the engine of its route (null: not llama.cpp or Locals), whether the broker
 * serves it, and the context its route gives one request (0: unset, the record's window alone).
 */
export interface LocalMember {
  model: string;
  engine: BrokerEngine | null;
  managed: boolean;
  ctx: number;
}

export type LocalSizing =
  | {
      state: "calibrated";
      kind: TaskKind;
      inputTokens: number;
      /** The budget in bytes: min(fill, window - cap - overhead) tokens. */
      budgetBytes: number;
      /** The window bound alone, (window - cap - overhead) tokens in bytes: the most an explicit max_payload_kb may take. */
      windowBudgetBytes: number;
      maxTokens: number;
      models: string[];
      /** One stderr line per member left out because its record is failed. */
      notes: string[];
    }
  /** Managed members with no record: the command waits for every one before sizing (round 3, M2). */
  | { state: "await"; models: Array<{ engine: BrokerEngine; model: string }>; head: string }
  /** No ok record for the head model (unmanaged, or a failed record): the 400 KB default and the profile max_tokens stay; `note` is the unmanaged line. */
  | { state: "default"; note: string | null };

/** An ok record carries every field below (calibration/record.ts recordSchemaErrors); a missing one is a bug, never a guess. */
function need<T>(v: T | undefined, model: string, field: string): T {
  if (v === undefined) throw new Error(`calibration record of ${model} has status ok but no ${field}`);
  return v;
}

/** Spec 6 output_cap[k]: the user max_output_tokens wins; else max(min_output_tokens[k], the nominal cap of k's thinking mode). */
export function localOutputCap(record: CalibrationRecord, kind: TaskKind, userMaxOutput?: number): number {
  if (userMaxOutput !== undefined) return userMaxOutput;
  // The thinking mode Phase C sized the slot for: on for bug when Phase A proved thinking on works (spec 4.4).
  const thinkingOn = kind === "bug" && need(record.thinking_works, record.model, "thinking_works").on === true;
  return Math.max(need(record.min_output_tokens, record.model, "min_output_tokens")[kind], thinkingOn ? CAP_ON : CAP_OFF);
}

/**
 * The chat_template_kwargs.enable_thinking value a request of task kind `kind` sends to a model with this ok record, or
 * undefined (send nothing: a template without the switch sees no change). USER directive 2026-10-28: thinking ON for bug
 * search, OFF for simple tasks (TRDD-1OOAH3LD gap C1-7, TRDD-ZGSGGHQG gap Z-3). WHY the asymmetry: the switch is sent only
 * where Phase A PROVED it works. bug sends true only when thinking_works.on === true (never an explicit false for bug);
 * fact and aggregate send false only when thinking_works.off === true ("leaky" means the model reasons in its visible
 * answer anyway, so an off request is not honoured and is not sent).
 */
export function localThinkingSwitch(record: CalibrationRecord, kind: TaskKind): boolean | undefined {
  const works = need(record.thinking_works, record.model, "thinking_works");
  if (kind === "bug") return works.on === true ? true : undefined;
  return works.off === true ? false : undefined;
}

/**
 * localThinkingSwitch for one send: undefined unless the route is a llama.cpp or Locals api, `tool` is in the task-kind
 * table, and `model` has an ok calibration record (the same readRecordStatus + readRecord pair planLocalSizing uses, so a
 * stale-harness or failed record never switches anything). `api` is the api preset of the route the request is sent to.
 * PER MODEL on purpose: every ensemble member and fallback target has its own record and its own thinking behaviour.
 */
export function localThinkingFor(dir: string, tool: string | undefined, model: string, api: string | undefined): boolean | undefined {
  if (tool === undefined || api === undefined) return undefined;
  const engine = localEngineOf(api);
  const entry = taskEntryOf(tool);
  if (engine === null || entry === undefined) return undefined;
  if (readRecordStatus(dir, engine, model).state !== "ok") return undefined;
  const record = readRecord(dir, engine, model);
  return record === null ? undefined : localThinkingSwitch(record, entry.kind);
}

/** The window a request of this record gets on a route giving `ctx` tokens (0: unset): min(ctx, window_tokens). */
function windowOf(record: CalibrationRecord, ctx: number): number {
  const w = need(record.window_tokens, record.model, "window_tokens");
  return ctx > 0 ? Math.min(ctx, w) : w;
}

/**
 * Spec 6 input_budget[k] in tokens for one record, on a route giving `ctx` tokens per request (0: unset). An unfit kind
 * (fill 0) throws: P7 does not route to the next model, and sending it a request the calibration failed would be a
 * silent quality loss. Below MIN_LOCAL_INPUT_TOKENS it throws naming the context, the output cap (and whether the
 * user's request_options set it) and the smallest context that works.
 */
export function localInputBudget(record: CalibrationRecord, kind: TaskKind, outputCap: number, ctx: number, capFromUser = false): number {
  const fill = need(record.fill_tokens, record.model, "fill_tokens")[kind];
  if (fill === 0) {
    const why = record.unfit_reasons?.[kind];
    throw new Error(`model '${record.model}' is unfit for ${kind} tasks (calibration${why !== undefined ? `: ${why}` : ": failed at the 2048-token floor"}); llm-ext models calibration-status`);
  }
  // The calibration window W, not main.slot_ctx (coordinator ruling 2026-10-31; spec 6 "P7 as built"). Safe for a real
  // record: a Phase B step ran only when step + cap + 64 fit W, so W - cap - 512 cuts a passing fill by at most 448.
  const windowTokens = need(record.window_tokens, record.model, "window_tokens");
  const budget = Math.min(fill, windowOf(record, ctx) - outputCap - SLOT_OVERHEAD);
  if (budget < MIN_LOCAL_INPUT_TOKENS) {
    const smallest = outputCap + SLOT_OVERHEAD + MIN_LOCAL_INPUT_TOKENS;
    const window = ctx > 0 ? `context ${ctx}` : "no context_window";
    const cap = capFromUser ? `output cap ${outputCap} (request_options max_output_tokens)` : `output cap ${outputCap}`;
    throw new Error(
      `model '${record.model}': input budget ${budget} tokens is below ${MIN_LOCAL_INPUT_TOKENS} for ${kind} tasks (${window}, calibration window ${windowTokens}, ` +
        `${cap}, prompt overhead ${SLOT_OVERHEAD}); the smallest context that works is ${smallest} tokens`,
    );
  }
  return budget;
}

/**
 * The input sizing of one command on a local profile. null: the head model is not on a llama.cpp or Locals route, or
 * the command is not in TASK_KIND_BY_TOOL; nothing changes. "await": one or more managed members have no record yet; the
 * command waits for every one (waitForCalibration), then plans again. "default": the head has no ok record (unmanaged,
 * or failed: the broker fails its jobs with the record's message). "calibrated": sized from every ok member; a failed
 * member is left out with a note; an unmanaged member with no record is left out silently (it keeps the defaults).
 */
export function planLocalSizing(args: {
  dir: string;
  tool: string;
  /** Head first (the model a single request goes to), then fallbacks and ensemble members. */
  members: readonly LocalMember[];
  /** The user request_options max_output_tokens for this tool, when the profile sets request_options. */
  userMaxOutput?: number;
}): LocalSizing | null {
  const head = args.members[0];
  const entry = taskEntryOf(args.tool);
  if (head === undefined || head.engine === null || entry === undefined) return null;
  const { kind } = entry;
  const local = args.members.filter((m): m is LocalMember & { engine: BrokerEngine } => m.engine !== null);
  const status = new Map(local.map((m) => [m.model, readRecordStatus(args.dir, m.engine, m.model)]));
  // Round 3 (M2): every managed member with no record is waited for, not only the head.
  const missing = local.filter((m) => m.managed && status.get(m.model)?.state === "missing");
  if (missing.length > 0) return { state: "await", models: missing.map((m) => ({ engine: m.engine, model: m.model })), head: head.model };
  if (status.get(head.model)?.state !== "ok") {
    // Decision 3: an unmanaged route is never calibrated, so it keeps the default and says so (never a silent change).
    const note = head.managed ? null : `[llm-externalizer] ${head.model} (${head.engine}) has no ok calibration record: input keeps the 400 KB default (unmanaged route; calibration covers server: managed profiles)\n`;
    return { state: "default", note };
  }
  const notes: string[] = [];
  const sized: Array<{ record: CalibrationRecord; ctx: number }> = [];
  for (const m of local) {
    const s = status.get(m.model);
    if (s?.state === "failed") notes.push(`[llm-externalizer] ${m.model} is left out of the input sizing: ${s.message}\n`);
    if (s?.state !== "ok") continue;
    const record = readRecord(args.dir, m.engine, m.model);
    if (record !== null) sized.push({ record, ctx: m.ctx });
  }
  const capFromUser = args.userMaxOutput !== undefined;
  const maxTokens = Math.max(...sized.map((s) => localOutputCap(s.record, kind, args.userMaxOutput)));
  const inputTokens = Math.min(...sized.map((s) => localInputBudget(s.record, kind, maxTokens, s.ctx, capFromUser)));
  const windowTokens = Math.min(...sized.map((s) => windowOf(s.record, s.ctx) - maxTokens - SLOT_OVERHEAD));
  const bytesPerToken = Math.min(...sized.map((s) => need(s.record.chars_per_token, s.record.model, "chars_per_token"))) * CHARS_PER_TOKEN_SAFETY;
  return {
    state: "calibrated",
    kind,
    inputTokens,
    budgetBytes: Math.floor(inputTokens * bytesPerToken),
    windowBudgetBytes: Math.floor(windowTokens * bytesPerToken),
    maxTokens,
    models: sized.map((s) => s.record.model),
    notes,
  };
}

/** The finished phases and trial count of a model's calibration progress file, for the waiting command's progress line. */
function progressText(dir: string, engine: BrokerEngine, model: string): string {
  try {
    const p = JSON.parse(readFileSync(progressPath(dir, engine, model), "utf8")) as { phases?: Record<string, string>; trials?: unknown[] };
    const phases = Object.entries(p.phases ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
    return `phases done: ${phases || "none"}; ${p.trials?.length ?? 0} trials`;
  } catch {
    return "not started yet";
  }
}

/**
 * Round 2 gap 1, round 3 (coordinator 2026-10-31): wait for the calibration record of every model in `models` before a
 * command sizes its input. `start` queues their calibration the way the broker does for a held job (queue.json plus
 * the runner) and THROWS when it cannot: a failed enqueue fails the command, never a silent wait. It runs again every
 * `restartMs` (the enqueue keeps one entry per model, ensureCalibrator starts at most one live runner), so a runner that
 * died is restarted. One line when the wait starts, a progress line every `progressMs`. Ends when no model is missing
 * a record; the head's failed record ends it with that record's message (the broker's own text for the model); a
 * failed member is left for planLocalSizing to note; a command stop (--command_timeout) throws CommandStoppedError.
 */
export async function waitForCalibration(o: {
  dir: string;
  models: ReadonlyArray<{ engine: BrokerEngine; model: string }>;
  head: string;
  start: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  stopReason: () => string | null;
  write: (line: string) => void;
  pollMs?: number;
  restartMs?: number;
  progressMs?: number;
}): Promise<void> {
  const names = o.models.map((m) => `${m.model} (${m.engine})`).join(", ");
  await o.start();
  o.write(`[llm-externalizer] waiting for the calibration of ${names} before sizing this command; a calibration takes hours (about 1-2 h for a 1.7B model, 3-6 h for a 4B one); llm-ext models calibration-status shows its progress\n`);
  const began = Date.now();
  let started = began;
  let reported = began;
  for (;;) {
    let pending = 0;
    for (const m of o.models) {
      const s = readRecordStatus(o.dir, m.engine, m.model);
      if (s.state === "failed" && m.model === o.head) throw new Error(s.message);
      if (s.state === "missing") pending += 1;
    }
    if (pending === 0) return;
    const stop = o.stopReason();
    if (stop !== null) throw new CommandStoppedError(stop);
    const now = Date.now();
    if (now - started >= (o.restartMs ?? CALIBRATION_RESTART_MS)) {
      started = now;
      await o.start();
    }
    if (now - reported >= (o.progressMs ?? CALIBRATION_PROGRESS_MS)) {
      reported = now;
      const each = o.models.map((m) => `${m.model}: ${readRecordStatus(o.dir, m.engine, m.model).state === "missing" ? progressText(o.dir, m.engine, m.model) : "done"}`).join("; ");
      o.write(`[llm-externalizer] still waiting for calibration after ${Math.round((now - began) / 60_000)} min: ${each}\n`);
    }
    await o.sleep(o.pollMs ?? CALIBRATION_POLL_MS);
  }
}
