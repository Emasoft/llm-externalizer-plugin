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
 * `system`, or a handful of bookkeeping types (`queue-operation`,
 * `attachment`, `last-prompt`, `summary`, ...) that carry no conversational
 * content this command needs. Only `user`/`assistant`/`system` lines ever
 * produce a `Turn`; everything else is silently ignored (not an error —
 * it is simply out of scope).
 *
 * A malformed line (JSON.parse failure) is skipped and counted — real
 * transcripts get truncated mid-write when a session is killed, so this
 * MUST NOT crash the reader. Anything else (an unexpected block shape
 * inside an otherwise-valid line) degrades gracefully to "ignore this
 * block" rather than throwing, because the transcript format is not
 * versioned and a newer Claude Code build can add a block type this
 * module has never seen.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
}

// Heuristic (not a real tokenizer): a `moderate` prune keeps this many lines
// at the head and this many at the tail of an oversized tool_result.
const DEFAULT_MODERATE_TRUNCATE_LINES = 20;

// One-line budget for a tool_use argument summary, and the per-value
// truncation point beyond which a string argument is elided rather than
// quoted in full (Write's `content`, Bash's `command` output, etc.).
const ARG_SUMMARY_MAX_LEN = 160;
const ARG_VALUE_TRUNCATE_AT = 80;

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
    bytesOut += Buffer.byteLength(JSON.stringify(turn), "utf8");
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
  // queue-operation, attachment, last-prompt, summary, and any future
  // bookkeeping line type: out of scope for a session summary.
  return null;
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
    if (content.trim() !== "") textParts.push(content);
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

  return {
    role,
    timestamp: typeof d.timestamp === "string" ? d.timestamp : null,
    uuid: typeof d.uuid === "string" ? d.uuid : null,
    parentUuid: typeof d.parentUuid === "string" ? d.parentUuid : null,
    text: textParts.join("\n"),
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
    if (typeof b.text === "string" && b.text.trim() !== "") textParts.push(b.text);
    return;
  }

  if (b.type === "thinking") {
    // `aggressive` drops thinking blocks outright — they are the model's
    // scratchpad, not narrative the user needs back.
    if (pruneLevel === "aggressive") return;
    if (typeof b.thinking === "string" && b.thinking.trim() !== "") {
      textParts.push(`[thinking] ${b.thinking}`);
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
      if (typeof msg === "string" && msg.trim() !== "") errors.push(msg);
    }
  }

  const hookErrors = d.hookErrors;
  if (Array.isArray(hookErrors)) {
    for (const e of hookErrors) {
      if (typeof e === "string" && e.trim() !== "") errors.push(e);
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

/** A `tool_result` block's `content` is a string OR an array of `{type:"text", text}` blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item !== null && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
          const t = (item as Record<string, unknown>).text;
          return typeof t === "string" ? t : "";
        }
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
      rendered = `"${value.slice(0, ARG_VALUE_TRUNCATE_AT)}…(${value.length} chars)"`;
    } else {
      rendered = JSON.stringify(value);
    }
    return `${key}=${rendered}`;
  });
  return truncateOneLine(entries.join(", "), ARG_SUMMARY_MAX_LEN);
}

function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
