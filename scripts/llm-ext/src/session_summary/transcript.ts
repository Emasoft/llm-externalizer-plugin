/**
 * Streaming reader + pruner for Claude Code session JSONL transcripts.
 *
 * Real transcripts can exceed 250 MB (see TRDD-T4MZ8YQR §Verified facts —
 * the largest local transcript measured 265,443,684 bytes), so this module
 * MUST NOT load the file into memory. It streams line by line via
 * `node:readline` over a `createReadStream`, the same pattern already
 * proven in `src/cluster/jsonl.ts` for 1M-row corpora.
 *
 * A JSONL transcript line's top-level `type` can be `user`, `assistant`,
 * `system`, or a handful of bookkeeping types (`attachment`, `last-prompt`,
 * `summary`, ...) that carry no conversational content this command needs
 * and are silently ignored (not an error — simply out of scope).
 *
 * `queue-operation` is the one bookkeeping type that DOES carry real user
 * intent: when the user sends a message while the assistant is still
 * working on the previous turn ("the user sent a new message while you
 * were working"), Claude Code records it as `{type:"queue-operation",
 * operation:"enqueue", content:"<the typed text>"}` — NOT as a `type:"user"`
 * line. Only `operation:"enqueue"` entries are read (`"dequeue"`/`"remove"`
 * carry no independent content — `"dequeue"`'s `content` is `null`, and
 * `"remove"`'s duplicates the `"enqueue"` that created it, so reading them
 * too would double-count). An `enqueue` entry whose payload is itself
 * machine-injected (a task-completion notification, a cross-session relay)
 * is excluded by `isMachineGeneratedUserTurn` below — verified against a
 * real transcript, that payload is ALSO delivered a second time later as a
 * genuine `type:"user"` turn, so keeping the queue-operation copy too would
 * duplicate it, not recover lost content.
 *
 * A malformed line (JSON.parse failure) is skipped and counted — real
 * transcripts get truncated mid-write when a session is killed, so this
 * MUST NOT crash the reader. Anything else (an unexpected block shape
 * inside an otherwise-valid line) degrades gracefully to "ignore this
 * block" rather than throwing, because the transcript format is not
 * versioned and a newer Claude Code build can add a block type this
 * module has never seen.
 *
 * When `strippedOutputPath` is given, the pruned turns are ALSO streamed to
 * disk as JSONL via `createWriteStream`, one turn at a time — the same
 * never-buffer-the-whole-thing discipline applies to the write side, so the
 * stripped artifact itself never forces a 265 MB string into memory either.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { once } from "node:events";

export type PruneLevel = "aggressive" | "moderate" | "none";

export interface ToolCallSummary {
  name: string;
  argSummary: string;
}

export interface Turn {
  role: "user" | "assistant" | "system";
  timestamp: string | null;
  uuid: string | null;
  parentUuid: string | null;
  text: string;
  toolCalls: ToolCallSummary[];
  errors: string[];
}

export interface TranscriptStats {
  linesRead: number;
  linesSkippedMalformed: number;
  turnsEmitted: number;
  bytesIn: number;
  bytesOut: number;
  /** bytesOut / bytesIn — the fraction of the raw transcript that survived pruning. */
  pruneRatio: number;
}

export interface ReadTranscriptResult {
  turns: Turn[];
  stats: TranscriptStats;
}

export interface ReadTranscriptOptions {
  /** Default "none" here — the CLI layer (P5) is what defaults to "aggressive". */
  pruneLevel?: PruneLevel;
  /** Lines kept at each end of a truncated tool_result under `moderate`. */
  moderateTruncateLines?: number;
  /**
   * When set, every pruned `Turn` is ALSO streamed to this path as JSONL (one
   * turn per line, in transcript order) — the inspectable, on-disk stripped
   * artifact the owner wants to measure and split, instead of trusting an
   * in-memory list nobody can look at. Written incrementally via
   * `createWriteStream`, one turn at a time, as it is produced — never
   * buffered as a joined string first, for the same reason the read side
   * never buffers the 265 MB source transcript (see module docstring).
   */
  strippedOutputPath?: string;
}

// Heuristic (not a real tokenizer): a `moderate` prune keeps this many lines
// at the head and this many at the tail of an oversized tool_result.
const DEFAULT_MODERATE_TRUNCATE_LINES = 20;

// One-line budget for a tool_use argument summary, and the per-value
// truncation point beyond which a string argument is elided rather than
// quoted in full (Write's `content`, Bash's `command` output, etc.).
const ARG_SUMMARY_MAX_LEN = 160;
const ARG_VALUE_TRUNCATE_AT = 80;

// The summarizer is a TEXT model — it cannot read an image, so a base64
// blob (a screenshot easily runs hundreds of KB) contributes zero
// information while consuming an enormous share of the chunk budget,
// pushing genuine content out of the chunk. Dropped at EVERY prune level,
// including `none`: "none" means "keep TEXT detail", and an image is not
// text detail the pipeline can process either way. Replaced with a short
// marker rather than silently removed, so the narrative fact ("the user
// shared a screenshot") survives even though the pixels don't.
const IMAGE_OMITTED_MARKER = "[image omitted]";
const DATA_URI_IMAGE_RE = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

/** Redact any inline `data:image/...;base64,...` URI embedded in free text
 *  (a user-pasted screenshot markdown, a tool_result that echoes one back,
 *  ...) — distinct from an explicit `{type:"image"}` content block, which
 *  `extractBlock`/`toolResultText` intercept before any base64 is ever read
 *  into a string at all. Cheap short-circuit: only allocates a new string
 *  when the marker substring is actually present. */
function stripInlineImageData(text: string): string {
  if (!text.includes("data:image")) return text;
  return text.replace(DATA_URI_IMAGE_RE, IMAGE_OMITTED_MARKER);
}

// ---------------------------------------------------------------------------
// Machine-generated user-role turn exclusion (FIX 2).
//
// A user-role turn is dropped ONLY when it is WHOLLY one of these injected
// forms — never merely because a marker appears somewhere inside otherwise
// real user text. Being conservative here matters: a false exclusion here
// silently destroys real user intent, which is exactly the class of bug
// this module exists to stop causing.
// ---------------------------------------------------------------------------

// A cron-fired janitor heartbeat prompt, always beginning with this exact
// line followed by a dispatcher-stub script path. Never anything a human
// typed.
const JANITOR_HEARTBEAT_FIRST_LINE = "[janitor-heartbeat]";

// Injected verbatim by the harness when a turn produced no visible output,
// asking the assistant to continue. Fixed, exact string — never user text.
const NO_VISIBLE_OUTPUT_MARKER =
  "[Your previous response had no visible output. Please continue and produce a user-visible response.]";

// A SKILL's own documentation, loaded into context as a synthetic user turn.
// It always opens with this preamble followed by the skill's install path, then
// the skill body. Measured on a real transcript: 9 of 62 surviving user turns
// were skill loads (janitor-arm, janitor-resume, ...) — ~15% of the verbatim
// "All User Messages" section filled with text no human typed.
// Matched as a FIRST-LINE PREFIX, not an equality, because the trailing path
// varies per skill and per install. A human message opening with this exact
// preamble is not a realistic collision.
const SKILL_LOAD_FIRST_LINE_PREFIX = "Base directory for this skill: ";

// Whole-message XML-style tag pairs that carry zero human-authored text.
// `<command-name>`/`<command-message>`/`<command-args>` and the
// `<local-command-caveat>` preamble are slash-command plumbing echoed back
// as a synthetic user turn. `<system-reminder>` re-injected as an entire
// turn (rather than embedded alongside real text) is pure harness noise.
// `<task-notification>` and `<cross-session-message ...>` are background
// task / cross-session relays that Claude Code re-delivers a second time as
// a genuine `type:"user"` turn later — keeping either the queue-operation
// copy or an isolated notification-only turn would duplicate content, never
// recover any (see the module docstring for the verified evidence).
const WHOLLY_MACHINE_TAG_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["<system-reminder>", "</system-reminder>"],
  ["<command-name>", "</command-name>"],
  ["<command-message>", "</command-message>"],
  ["<command-args>", "</command-args>"],
  ["<local-command-caveat>", "</local-command-caveat>"],
  ["<local-command-stdout>", "</local-command-stdout>"],
  ["<task-notification>", "</task-notification>"],
  ["<cross-session-message", "</cross-session-message>"], // opening tag carries attributes
];

/**
 * True when `text` — the fully-assembled text of a user-role turn — is
 * WHOLLY machine-injected noise and should be dropped. Only ever called on
 * already-non-empty text; an empty turn is dropped elsewhere for an
 * unrelated reason (nothing to summarize).
 */
function isMachineGeneratedUserTurn(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;

  const firstLine = trimmed.split("\n", 1)[0];
  if (firstLine === JANITOR_HEARTBEAT_FIRST_LINE) return true;
  if (firstLine.startsWith(SKILL_LOAD_FIRST_LINE_PREFIX)) return true;
  if (trimmed === NO_VISIBLE_OUTPUT_MARKER) return true;

  // Repeatedly strip every known machine tag-pair (a caveat + command-name
  // pair, or several task-notifications, can appear back to back in one
  // turn); if nothing but whitespace survives, the turn was WHOLLY
  // machine plumbing rather than real text merely containing a marker.
  let stripped = trimmed;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of WHOLLY_MACHINE_TAG_PAIRS) {
      const openIdx = stripped.indexOf(open);
      if (openIdx === -1) continue;
      const closeIdx = stripped.indexOf(close, openIdx);
      if (closeIdx === -1) continue;
      stripped = stripped.slice(0, openIdx) + stripped.slice(closeIdx + close.length);
      changed = true;
    }
  }
  return stripped.trim() === "";
}

/**
 * Stream `filePath` line by line and return the pruned Turn list + stats.
 * Never buffers the whole file — memory usage is bounded by the turns kept
 * in `turns`, not by the file size.
 */
export async function readTranscript(
  filePath: string,
  options: ReadTranscriptOptions = {},
): Promise<ReadTranscriptResult> {
  const pruneLevel = options.pruneLevel ?? "none";
  const truncateLines = options.moderateTruncateLines ?? DEFAULT_MODERATE_TRUNCATE_LINES;

  const turns: Turn[] = [];
  let linesRead = 0;
  let linesSkippedMalformed = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  // Opened once, up front, and written to incrementally below — never a
  // single joined-string write, which is exactly the whole-file-in-memory
  // pattern this option exists to avoid.
  const strippedOut = options.strippedOutputPath ? createWriteStream(options.strippedOutputPath, { encoding: "utf8" }) : null;

  try {
    for await (const raw of rl) {
      if (raw.trim() === "") continue; // blank lines carry nothing; not counted either way

      linesRead++;
      bytesIn += Buffer.byteLength(raw, "utf8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        linesSkippedMalformed++;
        continue;
      }

      const turn = extractTurn(parsed, pruneLevel, truncateLines);
      if (turn === null) continue;
      turns.push(turn);
      const serialized = JSON.stringify(turn);
      bytesOut += Buffer.byteLength(serialized, "utf8");

      if (strippedOut) {
        // Respect backpressure: if the internal buffer is full, wait for
        // "drain" before writing the next line, same discipline the read
        // side gets for free from readline's async iterator.
        const wroteWithoutBackpressure = strippedOut.write(serialized + "\n");
        if (!wroteWithoutBackpressure) {
          await once(strippedOut, "drain");
        }
      }
    }
  } finally {
    if (strippedOut) {
      strippedOut.end();
      await once(strippedOut, "finish");
    }
  }

  const pruneRatio = bytesIn > 0 ? bytesOut / bytesIn : 0;
  return {
    turns,
    stats: {
      linesRead,
      linesSkippedMalformed,
      turnsEmitted: turns.length,
      bytesIn,
      bytesOut,
      pruneRatio,
    },
  };
}

function extractTurn(parsed: unknown, pruneLevel: PruneLevel, truncateLines: number): Turn | null {
  if (parsed === null || typeof parsed !== "object") return null;
  const d = parsed as Record<string, unknown>;

  if (d.type === "user" || d.type === "assistant") {
    return extractMessageTurn(d, d.type, pruneLevel, truncateLines);
  }
  if (d.type === "system") {
    return extractSystemTurn(d);
  }
  if (d.type === "queue-operation") {
    return extractQueueOperationTurn(d);
  }
  // attachment, last-prompt, summary, and any future bookkeeping line
  // type: out of scope for a session summary.
  return null;
}

/**
 * A message the user typed while the assistant was still working on the
 * previous turn — see the module docstring. Only `operation:"enqueue"` ever
 * carries independent content; `"dequeue"` has `content:null` and
 * `"remove"` duplicates its own prior `"enqueue"`, so both are correctly
 * skipped by the plain-string check below without special-casing the
 * operation name.
 */
function extractQueueOperationTurn(d: Record<string, unknown>): Turn | null {
  if (d.operation !== "enqueue") return null;
  const content = d.content;
  if (typeof content !== "string" || content.trim() === "") return null;

  const text = stripInlineImageData(content);
  if (isMachineGeneratedUserTurn(text)) return null;

  return {
    role: "user",
    timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
    uuid: null, // queue-operation lines carry no uuid/parentUuid in Claude Code's transcript format
    parentUuid: null,
    text,
    toolCalls: [],
    errors: [],
  };
}

function extractMessageTurn(
  d: Record<string, unknown>,
  role: "user" | "assistant",
  pruneLevel: PruneLevel,
  truncateLines: number,
): Turn | null {
  const message = d.message;
  if (message === null || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>).content;

  const textParts: string[] = [];
  const toolCalls: ToolCallSummary[] = [];
  const errors: string[] = [];

  if (typeof content === "string") {
    if (content.trim() !== "") textParts.push(stripInlineImageData(content));
  } else if (Array.isArray(content)) {
    for (const block of content) {
      extractBlock(block, pruneLevel, truncateLines, textParts, toolCalls, errors);
    }
  }
  // Any other content shape on an otherwise well-formed line: the line
  // parsed fine, so this is not a malformed-line case — just nothing to
  // extract. Falls through to the empty-turn check below.

  if (textParts.length === 0 && toolCalls.length === 0 && errors.length === 0) {
    return null; // e.g. an assistant line whose only content was stripped by pruning
  }

  const text = textParts.join("\n");

  // FIX 2: a user-role turn that is WHOLLY machine-injected noise (a cron
  // heartbeat, slash-command plumbing, a re-delivered task notification, ...)
  // carries zero user intent and only dilutes the verbatim user-messages
  // section. Never applied to assistant/tool turns — those aren't claiming
  // to be something the user said.
  if (role === "user" && errors.length === 0 && isMachineGeneratedUserTurn(text)) {
    return null;
  }

  return {
    role,
    timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
    uuid: typeof d.uuid === "string" ? d.uuid : null,
    parentUuid: typeof d.parentUuid === "string" ? d.parentUuid : null,
    text,
    toolCalls,
    errors,
  };
}

function extractBlock(
  block: unknown,
  pruneLevel: PruneLevel,
  truncateLines: number,
  textParts: string[],
  toolCalls: ToolCallSummary[],
  errors: string[],
): void {
  if (block === null || typeof block !== "object") return;
  const b = block as Record<string, unknown>;

  if (b.type === "text") {
    if (typeof b.text === "string" && b.text.trim() !== "") textParts.push(stripInlineImageData(b.text));
    return;
  }

  if (b.type === "image") {
    // A text model cannot read this regardless of prune level — the
    // base64 `source.data` is never even read into a string; only the
    // narrative marker survives. See IMAGE_OMITTED_MARKER's header.
    textParts.push(IMAGE_OMITTED_MARKER);
    return;
  }

  if (b.type === "thinking") {
    // `aggressive` drops thinking blocks outright — they are the model's
    // scratchpad, not narrative the user needs back.
    if (pruneLevel === "aggressive") return;
    if (typeof b.thinking === "string" && b.thinking.trim() !== "") {
      textParts.push(`[thinking] ${stripInlineImageData(b.thinking)}`);
    }
    return;
  }

  if (b.type === "tool_use") {
    const name = typeof b.name === "string" ? b.name : "unknown_tool";
    toolCalls.push({ name, argSummary: summarizeToolInput(b.input) });
    return;
  }

  if (b.type === "tool_result") {
    const resultText = toolResultText(b.content);
    const isError = b.is_error === true;
    if (isError) {
      errors.push(
        resultText.trim() !== ""
          ? resultText
          : `(tool_use_id ${String(b.tool_use_id ?? "unknown")} reported an error with no message)`,
      );
    }
    if (pruneLevel === "aggressive") {
      // Payloads are dropped by design under `aggressive` — error text is
      // the one exception, kept above regardless of prune level.
      if (isError) textParts.push(`[tool_error] ${resultText}`);
      return;
    }
    if (pruneLevel === "moderate") {
      textParts.push(`[tool_result] ${headTailTruncate(resultText, truncateLines)}`);
      return;
    }
    textParts.push(`[tool_result] ${resultText}`);
    return;
  }

  // Unknown/forward-compatible block type: skip rather than throw, so a
  // transcript from a newer Claude Code build degrades gracefully instead
  // of crashing mid-summary.
}

function extractSystemTurn(d: Record<string, unknown>): Turn | null {
  const errors: string[] = [];

  if (d.subtype === "api_error") {
    const err = d.error;
    if (err !== null && typeof err === "object") {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim() !== "") errors.push(stripInlineImageData(msg));
    }
  }

  const hookErrors = d.hookErrors;
  if (Array.isArray(hookErrors)) {
    for (const e of hookErrors) {
      if (typeof e === "string" && e.trim() !== "") errors.push(stripInlineImageData(e));
    }
  }

  if (errors.length === 0) return null; // routine system bookkeeping — nothing to summarize

  return {
    role: "system",
    timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
    uuid: typeof d.uuid === "string" ? d.uuid : null,
    parentUuid: typeof d.parentUuid === "string" ? d.parentUuid : null,
    text: "",
    toolCalls: [],
    errors,
  };
}

/** A `tool_result` block's `content` is a string OR an array of blocks —
 *  normally `{type:"text", text}`, but a tool (e.g. a screenshot capture)
 *  can also return `{type:"image", source:{...}}`; that base64 is never
 *  read into a string, only the marker survives (see IMAGE_OMITTED_MARKER's
 *  header). */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return stripInlineImageData(content);
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item === null || typeof item !== "object") return "";
        const it = item as Record<string, unknown>;
        if (it.type === "text") {
          const t = it.text;
          return typeof t === "string" ? stripInlineImageData(t) : "";
        }
        if (it.type === "image") return IMAGE_OMITTED_MARKER;
        return "";
      })
      .filter((s) => s !== "")
      .join("\n");
  }
  return "";
}

function headTailTruncate(text: string, n: number): string {
  const lines = text.split("\n");
  if (lines.length <= n * 2) return text;
  const head = lines.slice(0, n);
  const tail = lines.slice(-n);
  const omitted = lines.length - n * 2;
  return [...head, `... [${omitted} lines omitted] ...`, ...tail].join("\n");
}

function summarizeToolInput(input: unknown): string {
  if (input === undefined) return "";
  if (input === null || typeof input !== "object") {
    return truncateOneLine(String(input), ARG_SUMMARY_MAX_LEN);
  }
  const entries = Object.entries(input as Record<string, unknown>).map(([key, value]) => {
    let rendered: string;
    if (typeof value === "string" && value.length > ARG_VALUE_TRUNCATE_AT) {
      const stripped = stripInlineImageData(value);
      rendered = `"${stripped.slice(0, ARG_VALUE_TRUNCATE_AT)}…(${value.length} chars)"`;
    } else {
      rendered = JSON.stringify(typeof value === "string" ? stripInlineImageData(value) : value);
    }
    return `${key}=${rendered}`;
  });
  return truncateOneLine(entries.join(", "), ARG_SUMMARY_MAX_LEN);
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
