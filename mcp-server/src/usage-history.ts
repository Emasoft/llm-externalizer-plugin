/**
 * Global usage history — one flat, human-readable line per individual LLM web
 * request, appended to `~/.llm-externalizer/history.log`.
 *
 * Spec: design/tasks/TRDD-20260524_054023+0200-44256ba2-global-usage-history.md
 * (as amended live: per-WEB-REQUEST granularity + a trailing OP-ID column so
 * every request from the same tool/command invocation can be correlated later).
 *
 * Line format (7 fields, " - " separated):
 *
 *   <TIMESTAMP> - <PROJECT-DIR> - <TOOL/COMMAND(params)> - <SUCCESS|FAIL> - <DURATION> - <COST> - <OP-ID>
 *
 * - TIMESTAMP  local ISO + GMT offset, `YYYY-MM-DDTHH:MM:SS±HHMM` (sortable).
 * - PROJECT-DIR `CLAUDE_PROJECT_DIR`, else git top-level of cwd, else cwd.
 * - TOOL(params) originating tool/command + a COMPACT, redacted, truncated
 *                param summary (never a whole snippet/file body).
 * - SUCCESS|FAIL whether THAT single web request succeeded.
 * - DURATION    wall-clock of THAT request, `<N>ms` (or `<N.N>s` when ≥1000ms).
 * - COST        USD of THAT request, `$0.000000` (6dp); `$0.000000` when none.
 * - OP-ID       `op-<8hex>` shared by every request of one invocation.
 *
 * Design notes:
 * - `ctxStore` carries READ-ONLY per-invocation context (tool, params, project,
 *   opId). It is set ONCE per tool/CLI invocation at the dispatch chokepoint.
 * - `recordRequest()` is called at each LLM HTTP call site the moment that
 *   request's ok/duration/cost are known; it reads `ctxStore` and appends one
 *   line. There is NO summing — each web request is its own line.
 * - A `recordRequest()` with no active `ctxStore` (direct/util call) still
 *   writes a well-formed line with a fresh standalone opId and a `(direct)`
 *   tool label.
 * - Writing history MUST NEVER break or slow the actual work: every disk touch
 *   is wrapped in try/catch and swallowed (best-effort, debug-only).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { getConfigDir } from "./config.js";
import { redactSecrets } from "./security_scan/intake.js";

/** Read-only context carried for the lifetime of one tool/CLI invocation. */
export interface UsageContext {
  /** Originating tool or CLI command name. */
  tool: string;
  /** Compact, redacted, truncated parameter summary. */
  params: string;
  /** Absolute project directory the request originated from. */
  project: string;
  /** `op-<8hex>` shared by every web request of this invocation. */
  opId: string;
}

/**
 * Per-invocation context store. `recordRequest` reads the active store to know
 * which tool/command/opId to attribute a web request to. AsyncLocalStorage
 * scopes this PER invocation, so concurrent tool calls never cross-attribute.
 */
export const ctxStore = new AsyncLocalStorage<UsageContext>();

/** Generate a fresh operation id (`op-<8 hex chars>`). */
export function newOpId(): string {
  return `op-${randomBytes(4).toString("hex")}`;
}

/** Absolute path of the history log file. Honors LLM_EXT_CONFIG_DIR via getConfigDir(). */
export function getHistoryPath(): string {
  return join(getConfigDir(), "history.log");
}

// ── Project resolution ───────────────────────────────────────────────────
// CLAUDE_PROJECT_DIR wins; else the git top-level of cwd; else cwd. Always an
// absolute path. Never throws — falls back to cwd on any error.
export function resolveProject(): string {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    /* not a git repo, or git missing — fall through to cwd */
  }
  return process.cwd();
}

// ── Param summary ────────────────────────────────────────────────────────
// Produce a COMPACT one-line summary of the call arguments: scalars inline,
// long strings truncated to ~80 chars, arrays as `name[N]`, nested objects as
// `name{...}`, secrets redacted. NEVER dumps a whole snippet/file body.

/** Max characters kept from any single string value before truncation. */
const MAX_STR = 80;

/** Truncate a one-line string value to MAX_STR chars with an ellipsis marker. */
function truncateValue(s: string): string {
  // Collapse newlines/tabs so a multi-line snippet can never break the single
  // log line, then bound the length so a file body never lands in the log.
  const flat = s.replace(/[\r\n\t]+/g, " ");
  if (flat.length <= MAX_STR) return flat;
  return `${flat.slice(0, MAX_STR)}…(${flat.length})`;
}

/** Redact secrets from a string, best-effort (never throws). */
function redactString(s: string): string {
  try {
    return redactSecrets(s).redacted;
  } catch {
    // Redaction must never break logging; if a pattern throws, drop the value
    // rather than risk egressing a secret into the log line.
    return "[REDACTED]";
  }
}

/** Compact one value (scalar/array/object) for the param summary. */
function summarizeValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return truncateValue(redactString(v));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") {
    // Keep the keys (cheap, useful), compact the values one level deep.
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 0) return "{}";
    const inner = keys
      .map((k) => `${k}=${summarizeScalarOnly((v as Record<string, unknown>)[k])}`)
      .join(",");
    return truncateValue(`{${inner}}`);
  }
  return truncateValue(redactString(String(v)));
}

/** One-level-deep value compactor used inside nested objects (no recursion blow-up). */
function summarizeScalarOnly(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return truncateValue(redactString(v));
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.length}]`;
  if (typeof v === "object") return "{…}";
  return truncateValue(redactString(String(v)));
}

/**
 * Build the compact `key=val, key2=val2` summary from a call's args object.
 * Returns "" for empty/absent args (caller renders `tool()` then).
 */
export function summarizeParams(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object" || Array.isArray(args)) {
    // Non-object args (rare) — summarize the whole thing as one value.
    return summarizeValue(args);
  }
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${summarizeValue(v)}`).join(", ");
}

// ── Line formatting ──────────────────────────────────────────────────────

/** Local ISO 8601 timestamp with GMT offset: `YYYY-MM-DDTHH:MM:SS±HHMM`. */
export function localIsoTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const mo = pad(d.getMonth() + 1);
  const da = pad(d.getDate());
  const h = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  // getTimezoneOffset() returns minutes BEHIND UTC (e.g. -120 for UTC+2), so a
  // positive value means we are WEST of GMT → the printed sign is inverted.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  return `${y}-${mo}-${da}T${h}:${mi}:${s}${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/** Format a wall-clock duration: `<N>ms`, or `<N.N>s` when ≥ 1000ms. */
export function formatDuration(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a USD cost with fixed 6 decimal places: `$0.000000`. */
export function formatCost(costUsd: number): string {
  const c = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  return `$${c.toFixed(6)}`;
}

/** Assemble one history line (without the trailing newline) from its fields. */
export function formatHistoryLine(fields: {
  timestamp: string;
  project: string;
  tool: string;
  params: string;
  ok: boolean;
  durationMs: number;
  costUsd: number;
  opId: string;
}): string {
  const toolField = fields.params
    ? `${fields.tool}(${fields.params})`
    : `${fields.tool}()`;
  return [
    fields.timestamp,
    fields.project,
    toolField,
    fields.ok ? "SUCCESS" : "FAIL",
    formatDuration(fields.durationMs),
    formatCost(fields.costUsd),
    fields.opId,
  ].join(" - ");
}

// ── Atomic append ────────────────────────────────────────────────────────

/**
 * Append one already-formatted line to the history log. Best-effort: any
 * failure (unwritable dir, full disk, EACCES) is swallowed so it can NEVER
 * break or slow the tool call. POSIX O_APPEND makes a single write of one
 * sub-PIPE_BUF line atomic across processes — no inter-process interleaving.
 */
export function appendHistoryLine(line: string): void {
  try {
    const dir = getConfigDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "history.log"), line + "\n", { flag: "a" });
  } catch {
    // Fail-open on LOGGING only — never on the actual work.
  }
}

// ── Per-request recorder ─────────────────────────────────────────────────

/**
 * Record ONE completed LLM web request. Reads the active `ctxStore` for the
 * originating tool/params/project/opId; if there is no active context (a direct
 * or utility call), it synthesizes a `(direct)` line with a fresh opId so the
 * line is still well-formed. Never throws.
 */
export function recordRequest(req: {
  ok: boolean;
  durationMs: number;
  costUsd: number;
}): void {
  try {
    const ctx = ctxStore.getStore();
    const line = formatHistoryLine({
      timestamp: localIsoTimestamp(),
      project: ctx?.project ?? resolveProject(),
      tool: ctx?.tool ?? "(direct)",
      params: ctx?.params ?? "",
      ok: req.ok,
      durationMs: req.durationMs,
      costUsd: req.costUsd,
      opId: ctx?.opId ?? newOpId(),
    });
    appendHistoryLine(line);
  } catch {
    // Logging must never propagate.
  }
}

/**
 * Run `fn` with a fresh per-invocation usage context installed. Called once at
 * each dispatch chokepoint (MCP `dispatchCallTool` + the CLI entry points).
 * Generates the shared opId here so every `recordRequest` inside `fn` correlates.
 */
export function withUsageContext<T>(
  init: { tool: string; params: string; project?: string },
  fn: () => T,
): T {
  const ctx: UsageContext = {
    tool: init.tool,
    params: init.params,
    project: init.project ?? resolveProject(),
    opId: newOpId(),
  };
  return ctxStore.run(ctx, fn);
}
